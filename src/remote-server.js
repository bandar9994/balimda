// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// The computer's side of "use my computer's models" (see remote.js): a small
// HTTP server on the local network that only answers requests encrypted with
// the key both devices derive from the sync key.

'use strict';

const http = require('http');
const os = require('os');
const { PORT, PATH, MAX_SKEW_MS, lock, unlock } = require('./remote');

const MAX_BODY = 16 * 1024 * 1024;

// IPv4 addresses the phone might reach this computer on: Wi-Fi/Ethernet, and
// VPNs like Tailscale (100.64.0.0/10) that work away from home too.
function localAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces)) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || a.address.startsWith('169.254.')) continue;
      out.push(a.address);
    }
  }
  const rank = (ip) => (/^(192\.168|10)\./.test(ip) ? 0 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : 2);
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b));
}

/**
 * @param getKey    async () => AES-GCM link key, or null when sharing is off
 * @param handlers  { op: async (msg, { emit, signal }) => result }
 */
function startRemoteServer({ getKey, handlers, port = PORT, host = '0.0.0.0' }) {
  const seen = new Map();  // nonce -> time, to refuse replayed requests

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== PATH) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        break;
      }
    }
    if (tooBig) {
      res.writeHead(413).end();
      return;
    }

    const key = await getKey();
    if (!key) {
      res.writeHead(503).end();
      return;
    }
    let msg;
    try {
      msg = await unlock(key, body.trim());
    } catch {
      res.writeHead(403).end();
      return;
    }
    const now = Date.now();
    for (const [n, t] of seen) if (now - t > 2 * MAX_SKEW_MS) seen.delete(n);
    if (typeof msg.nonce !== 'string' || seen.has(msg.nonce) || Math.abs(now - Number(msg.ts)) > MAX_SKEW_MS) {
      res.writeHead(403).end();
      return;
    }
    seen.set(msg.nonce, now);

    const handler = handlers[msg.op];
    if (!handler) {
      res.writeHead(400).end();
      return;
    }

    // The reply is a stream of encrypted lines. Text pieces are sent in small
    // batches so a fast model doesn't mean hundreds of tiny writes.
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    let chain = Promise.resolve();
    const write = (evt) => {
      chain = chain.then(async () => {
        if (!res.destroyed) res.write(`${await lock(key, { ...evt, re: msg.nonce })}\n`);
      });
      return chain;
    };
    let pending = '';
    let timer = null;
    const flush = () => {
      clearTimeout(timer);
      timer = null;
      if (pending) write({ t: 'delta', text: pending });
      pending = '';
    };
    const emit = (evt) => {
      if (evt.t === 'delta') {
        pending += evt.text;
        if (!timer) timer = setTimeout(flush, 40);
        return;
      }
      flush();
      write(evt);
    };
    try {
      const result = await handler(msg, { emit, signal: controller.signal });
      flush();
      await write({ t: 'done', result: result === undefined ? null : result });
    } catch (err) {
      flush();
      await write({ t: 'error', message: err.message || String(err) });
    }
    res.end();
  });

  return new Promise((resolve, reject) => {
    const listen = (p) => {
      server.once('error', (err) => {
        // Someone else has the usual port: take any free one (it's published
        // through sync with the addresses, so the phone still finds it).
        if (err.code === 'EADDRINUSE' && p !== 0) listen(0);
        else reject(err);
      });
      server.listen(p, host, () => {
        server.removeAllListeners('error');
        resolve({
          port: server.address().port,
          close: () => new Promise((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          })
        });
      });
    };
    listen(port);
  });
}

module.exports = { startRemoteServer, localAddresses };
