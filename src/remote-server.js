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

const MAX_BODY = 64 * 1024 * 1024;  // a chat with pictures (each about 350 KB here) can be big

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
function startRemoteServer({ getKey, handlers, port = PORT, host = '0.0.0.0', heartbeatMs = 15000, graceMs = 5 * 60 * 1000 }) {
  const seen = new Map();  // nonce -> time, to refuse replayed requests
  const jobs = new Map();  // job id -> reply that can be picked up again (see startJob)

  const server = http.createServer((req, res) => {
    // A phone that drops the connection mid-request (or any other failure)
    // must never take the app down with an unhandled rejection.
    handle(req, res).catch(() => {
      try {
        if (!res.headersSent) res.writeHead(500);
      } catch {
        // the connection is already gone
      }
      res.destroy();
    });
  });

  const handle = async (req, res) => {
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

    // Replies the phone can pick up again after a lost connection (see Job).
    if (msg.op === 'cancel') {
      const job = jobs.get(String(msg.job));
      if (job) job.controller.abort();
      const write = open(res, key, msg.nonce);
      await write({ t: 'done', result: null });
      res.end();
      return;
    }
    if (msg.job != null) {
      const id = String(msg.job);
      const from = Math.max(0, Number(msg.from) || 0);
      let job = jobs.get(id);
      if (!job) {
        if (from > 0 || !handlers[msg.op]) {
          // Picking up a reply this computer no longer has (it was restarted,
          // or no one came back for it in time).
          const write = open(res, key, msg.nonce);
          await write({ t: 'error', code: 'gone', message: 'The computer no longer has this reply (Balimda was restarted, or the connection was lost for too long).' });
          res.end();
          return;
        }
        job = startJob(id, handlers[msg.op], msg);
      }
      await follow(job, from, res, open(res, key, msg.nonce));
      return;
    }

    // One reply per connection (phones without resumable replies).
    const handler = handlers[msg.op];
    if (!handler) {
      res.writeHead(400).end();
      return;
    }
    const write = open(res, key, msg.nonce);
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const emit = batcher(write);
    // A heartbeat while the model is busy (loading, reading a long chat,
    // thinking): the phone can tell a slow model from a lost connection.
    const beat = setInterval(() => write({ t: 'ping' }), heartbeatMs);
    try {
      const result = await handler(msg, { emit, signal: controller.signal });
      emit.flush();
      await write({ t: 'done', result: result === undefined ? null : result });
    } catch (err) {
      emit.flush();
      await write({ t: 'error', message: err.message || String(err) });
    } finally {
      clearInterval(beat);
    }
    res.end();
  };

  // Starts the reply stream: encrypted lines, each tagged with the request's
  // nonce. Returns write(evt), which resolves once that line is written.
  function open(res, key, nonce) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    let chain = Promise.resolve();
    return (evt) => {
      chain = chain.then(async () => {
        if (!res.destroyed) res.write(`${await lock(key, { ...evt, re: nonce })}\n`);
      }).catch(() => {});
      return chain;
    };
  }

  // Text pieces are sent in small batches, so a fast model doesn't mean
  // hundreds of tiny writes. emit.flush() sends what's waiting.
  function batcher(send) {
    let pending = '';
    let timer = null;
    const flush = () => {
      clearTimeout(timer);
      timer = null;
      if (pending) send({ t: 'delta', text: pending });
      pending = '';
    };
    const emit = (evt) => {
      if (evt.t === 'delta') {
        pending += evt.text;
        if (!timer) timer = setTimeout(flush, 40);
        return;
      }
      flush();
      send(evt);
    };
    emit.flush = flush;
    return emit;
  }

  // A reply the phone asked for with a job id. It keeps being written when
  // the connection drops (e.g. the phone's Wi-Fi changed), and everything it
  // says is kept, so the phone can come back and carry on from where its
  // text stopped. With no one following it for `graceMs`, it's stopped; a
  // finished one is kept as long, for a phone that comes back late.
  function startJob(id, handler, msg) {
    const job = { id, events: [], listeners: new Set(), finished: false, controller: new AbortController(), timer: null };
    const push = (evt) => {
      if (job.finished) return;
      job.events.push(evt);
      if (evt.t === 'done' || evt.t === 'error') {
        job.finished = true;
        clearTimeout(job.timer);
        job.timer = setTimeout(() => jobs.delete(id), graceMs);
        if (job.timer.unref) job.timer.unref();
      }
      for (const l of [...job.listeners]) l(evt);
    };
    job.unfollowed = () => {
      if (job.finished || job.listeners.size) return;
      clearTimeout(job.timer);
      job.timer = setTimeout(() => job.controller.abort(), graceMs);
      if (job.timer.unref) job.timer.unref();
    };
    jobs.set(id, job);
    const emit = batcher(push);
    (async () => {
      try {
        const result = await handler(msg, { emit, signal: job.controller.signal });
        emit.flush();
        push({ t: 'done', result: result === undefined ? null : result });
      } catch (err) {
        emit.flush();
        push({ t: 'error', message: err.message || String(err) });
      }
    })();
    return job;
  }

  // Sends a job's events from number `from` on, then the new ones as they come.
  async function follow(job, from, res, write) {
    await write({ t: 'job', events: job.events.length });
    for (const evt of job.events.slice(from)) write(evt);
    if (!job.finished) {
      await new Promise((resolve) => {
        const beat = setInterval(() => write({ t: 'ping' }), heartbeatMs);
        const listener = (evt) => {
          write(evt);
          if (evt.t === 'done' || evt.t === 'error') stop();
        };
        const stop = () => {
          clearInterval(beat);
          job.listeners.delete(listener);
          res.off('close', gone);
          resolve();
        };
        const gone = () => {
          stop();
          job.unfollowed();
        };
        clearTimeout(job.timer);
        job.listeners.add(listener);
        if (res.destroyed) gone();  // the phone is already gone
        else res.on('close', gone);
      });
    }
    await write({ t: 'ping' });  // waits for everything before it to be written
    res.end();
  }

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
        // A later network error must not take the app down (an 'error' event
        // with no listener would).
        server.on('error', () => {});
        resolve({
          port: server.address().port,
          close: () => new Promise((r) => {
            // Sharing stops: so do the replies still being written.
            for (const job of jobs.values()) job.controller.abort();
            jobs.clear();
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
