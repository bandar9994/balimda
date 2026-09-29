// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// "Use my computer's models" from the phone. The Balimda desktop app can
// answer chat requests from the user's phone over the local network (see
// remote-server.js); this file has the protocol both sides share and the
// phone's side of it.
//
// Both devices already share a secret: the sync key. A separate key for this
// link is derived from it, and every request and every piece of the reply is
// encrypted with AES-GCM, so nothing on the Wi-Fi can read or fake it, and a
// computer only answers devices set up with the same sync passphrase. The
// computer publishes its network addresses through sync (settings.computers),
// so the phone finds it without typing anything.

'use strict';

const { toBase64, fromBase64 } = require('./sync');

const PORT = 47811;
const PATH = '/balimda/v1';
const MAX_SKEW_MS = 5 * 60 * 1000;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

class RemoteError extends Error {}

// AES-GCM key for this link, derived from the sync key (base64).
async function linkKey(syncKey) {
  const base = await subtle().importKey('raw', fromBase64(syncKey), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8.encode('balimda-remote'), info: utf8.encode('v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function lock(key, value) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, utf8.encode(JSON.stringify(value))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64(out);
}

async function unlock(key, text) {
  const bytes = fromBase64(text);
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
  return JSON.parse(fromUtf8.decode(plain));
}

const newNonce = () => toBase64(globalThis.crypto.getRandomValues(new Uint8Array(16)));

// Splits a streamed body into lines.
async function* lines(body) {
  const reader = body.getReader();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += fromUtf8.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

// A computer's model as shown in the phone's model list.
function modelName(computer, entry, model) {
  const where = entry.provider === 'ollama' ? computer.name : `${computer.name}, ${entry.short || entry.label}`;
  return `${model} (${where})`;
}

/**
 * The phone's side.
 * @param getKey        async () => sync key (base64) or null when sync isn't set up
 * @param getComputers  async () => settings.computers
 * @param fetch         fetch implementation
 */
function remoteComputers({ getKey, getComputers, fetch = globalThis.fetch, probeMs = 3000, quietMs = 60000 }) {
  const found = new Map();   // computer id -> { url, at }
  const models = new Map();  // shown model name -> { computer, provider, model }
  let keyCache = null;       // { syncKey, key }

  async function key() {
    const syncKey = await getKey();
    if (!syncKey) throw new RemoteError('Set up sync on this phone first. It\'s how Balimda finds your computer and keeps the connection private.');
    if (!keyCache || keyCache.syncKey !== syncKey) keyCache = { syncKey, key: await linkKey(syncKey) };
    return keyCache.key;
  }

  async function computers() {
    const list = Object.values((await getComputers()) || {}).filter((c) => c && c.enabled && Array.isArray(c.addrs) && c.addrs.length);
    if (!list.length) {
      throw new RemoteError('No computer is sharing its models yet. In Balimda on your computer, open Settings → Models & providers and turn on "Let my phone use this computer\'s models".');
    }
    return list;
  }

  // One request; calls onEvent for each event and returns the final result.
  // A lost connection throws a RemoteError with `lost` set.
  async function call(url, op, payload, { onEvent, signal, timeoutMs } = {}) {
    const k = await key();
    const nonce = newNonce();
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal) {
      if (signal.aborted) abort();
      signal.addEventListener('abort', abort);
    }
    const timer = timeoutMs ? setTimeout(abort, timeoutMs) : null;
    // The computer sends a heartbeat while its model is busy. Once one has
    // come, a long silence means the connection is gone (e.g. the computer
    // went to sleep), rather than waiting for ever. (Older versions of the
    // desktop app send none, so this never starts for them.)
    let watchdog = null;
    let stalled = false;
    const watch = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        stalled = true;
        abort();
      }, quietMs);
    };
    const lost = (why) => {
      const e = new RemoteError(why);
      e.lost = true;
      return e;
    };
    try {
      const res = await fetch(`${url}${PATH}`, {
        method: 'POST',
        // text/plain keeps this a "simple" request (no CORS preflight).
        headers: { 'Content-Type': 'text/plain' },
        body: await lock(k, { op, ts: Date.now(), nonce, ...payload }),
        signal: controller.signal
      });
      if (res.status === 403) throw new RemoteError('forbidden');
      if (res.status === 413) throw new RemoteError('This chat is too big to send to your computer (it has a lot of pictures). Start a new chat to carry on.');
      if (!res.ok) throw new RemoteError(`error ${res.status}`);
      if (timer) clearTimeout(timer);
      for await (const line of lines(res.body)) {
        if (!line.trim()) continue;
        const evt = await unlock(k, line.trim());
        if (evt.re !== nonce) throw new RemoteError('mismatched reply');
        if (evt.t === 'ping' || watchdog) watch();
        if (evt.t === 'ping') continue;
        if (evt.t === 'done') return evt.result;
        if (evt.t === 'error') {
          const e = new RemoteError(evt.message);
          e.fromComputer = true;
          throw e;
        }
        if (onEvent) onEvent(evt);
      }
      throw lost('The connection to your computer closed before the reply finished.');
    } catch (err) {
      if (stalled) throw lost('Your computer stopped answering.');
      if (signal && signal.aborted) throw err;
      // fetch's own "network error" / "Failed to fetch": the connection broke.
      if (err instanceof TypeError) throw lost(`The connection to your computer was lost (${err.message}).`);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      clearTimeout(watchdog);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }

  // Finds an address of the computer that answers, trying them all at once.
  async function locate(computer, { fresh = false } = {}) {
    await key();
    const known = found.get(computer.id);
    if (!fresh && known && Date.now() - known.at < 5 * 60 * 1000) return known.url;
    const urls = computer.addrs.map((a) => `http://${a.includes(':') ? `[${a}]` : a}:${computer.port || PORT}`);
    let forbidden = false;
    const attempts = urls.map((url) => call(url, 'hello', {}, { timeoutMs: probeMs }).then(() => url, (err) => {
      if (err.message === 'forbidden') forbidden = true;
      throw err;
    }));
    try {
      const url = await Promise.any(attempts);
      found.set(computer.id, { url, at: Date.now() });
      return url;
    } catch {
      found.delete(computer.id);
      if (forbidden) throw new RemoteError(`${computer.name} didn't accept this phone. Make sure both use the same sync account and passphrase.`);
      throw new RemoteError(`Couldn't reach ${computer.name}. Check that it's on with Balimda open, and that your phone is on the same Wi-Fi (or both are on Tailscale).`);
    }
  }

  async function listModels() {
    const list = await computers();
    const out = [];
    const errors = [];
    models.clear();
    await Promise.all(list.map(async (computer) => {
      try {
        const url = await locate(computer, { fresh: true });
        for (const entry of await call(url, 'models', {}, { timeoutMs: 15000 })) {
          for (const model of entry.models) {
            const name = modelName(computer, entry, model);
            models.set(name, { computer, provider: entry.provider, model });
            out.push(name);
          }
        }
      } catch (err) {
        errors.push(err);
      }
    }));
    if (!out.length && errors.length) throw errors[0];
    return out.sort();
  }

  async function streamChat(_cfg, req, onDelta, signal, onInfo = () => {}) {
    if (!models.has(req.model)) await listModels().catch(() => {});
    const target = models.get(req.model);
    if (!target) throw new RemoteError(`${req.model} isn't available right now. Check that the computer is on with Balimda open.`);
    let started = false;
    const send = async (url) => call(url, 'chat', {
      provider: target.provider,
      req: { ...req, model: target.model }
    }, {
      signal,
      onEvent: (evt) => {
        if (evt.t === 'info') {
          onInfo(evt.info);
          return;
        }
        if (evt.t !== 'delta') return;
        started = true;
        onDelta(evt.text);
      }
    });
    let url = await locate(target.computer);
    let result;
    try {
      result = await send(url);
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if (started && err.lost) {
        throw new RemoteError(`The connection to ${target.computer.name} was lost while it was replying. The computer may have gone to sleep, or the phone's Wi-Fi changed. The reply so far is kept: tap Regenerate to try again.`);
      }
      if (err.fromComputer || started) throw err;
      // The computer may have a new address (or went to sleep): look again.
      url = await locate(target.computer, { fresh: true });
      result = await send(url);
    }
    if (result && result.stats) result.stats = { ...result.stats, engine: `${result.stats.engine || 'Model'} on ${target.computer.name}` };
    return result;
  }

  // Pass the user's answer to an agent's request for permission back to the
  // computer that is running the agent.
  async function approve(modelName, payload) {
    if (!models.has(modelName)) await listModels().catch(() => {});
    const target = models.get(modelName);
    if (!target) throw new RemoteError(`${modelName} isn't available right now.`);
    return call(await locate(target.computer), 'approve', { provider: target.provider, payload }, { timeoutMs: 15000 });
  }

  return { listModels, streamChat, approve, locate, call };
}

module.exports = { PORT, PATH, MAX_SKEW_MS, RemoteError, linkKey, lock, unlock, lines, remoteComputers, modelName };
