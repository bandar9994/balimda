// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { linkKey, lock, remoteComputers, PATH } = require('../src/remote');
const { startRemoteServer, localAddresses } = require('../src/remote-server');
const { toBase64 } = require('../src/sync');
const { Storage } = require('../src/storage');
const { nodeFsBackend } = require('../src/backends/node-fs');

const syncKey = () => toBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A computer with one Ollama model that "types" its reply slowly.
async function computer(key, { words = ['Hello', ' from', ' your', ' PC'], delay = 5 } = {}) {
  const seen = { chats: [], aborted: 0 };
  const server = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    getKey: async () => linkKey(key),
    handlers: {
      hello: async () => ({ app: 'balimda', name: 'Desk' }),
      models: async () => [
        { provider: 'ollama', label: 'Ollama (local)', short: 'Ollama', models: ['qwen3.5:9b'] },
        { provider: 'anthropic', label: 'Anthropic Claude', short: 'Anthropic Claude', models: ['claude-opus-5'] }
      ],
      chat: async (msg, { emit, signal }) => {
        seen.chats.push(msg);
        let text = '';
        for (const w of words) {
          if (signal.aborted) {
            seen.aborted++;
            throw new Error('aborted');
          }
          await sleep(delay);
          text += w;
          emit({ t: 'delta', text: w });
        }
        if (msg.req.model === 'broken') throw new Error('model "broken" not found');
        return { text, stopReason: 'end_turn', stats: { engine: 'Ollama', device: 'Ollama', tokens: 4, ms: 20 } };
      }
    }
  });
  return { server, seen, addr: { id: 'desk', name: 'Desk', addrs: ['127.0.0.1'], port: server.port, enabled: true } };
}

// The app's own probe time (3 s): a busy test machine can take longer than a
// fraction of a second to answer, even on 127.0.0.1.
const client = (key, computers, opts = {}) => remoteComputers({
  getKey: async () => key,
  getComputers: async () => computers,
  ...opts
});

test('the phone lists the computer\'s models and streams a reply', async () => {
  const key = syncKey();
  const pc = await computer(key);
  try {
    const phone = client(key, { desk: pc.addr });
    assert.deepStrictEqual(await phone.listModels(), ['claude-opus-5 (Desk, Anthropic Claude)', 'qwen3.5:9b (Desk)']);
    const pieces = [];
    const result = await phone.streamChat({}, { model: 'qwen3.5:9b (Desk)', messages: [{ role: 'user', content: 'hi' }], think: false }, (t) => pieces.push(t));
    assert.strictEqual(pieces.join(''), 'Hello from your PC');
    assert.strictEqual(result.text, 'Hello from your PC');
    assert.strictEqual(result.stats.engine, 'Ollama on Desk');
    // The computer got the real model name and provider.
    assert.strictEqual(pc.seen.chats[0].provider, 'ollama');
    assert.strictEqual(pc.seen.chats[0].req.model, 'qwen3.5:9b');
    assert.strictEqual(pc.seen.chats[0].req.think, false);
  } finally {
    await pc.server.close();
  }
});

test('nothing readable crosses the network, and other keys and replays are refused', async () => {
  const key = syncKey();
  const pc = await computer(key);
  try {
    const url = `http://127.0.0.1:${pc.server.port}${PATH}`;
    const body = await lock(await linkKey(key), { op: 'models', ts: Date.now(), nonce: 'n1' });
    const first = await fetch(url, { method: 'POST', body });
    const text = await first.text();
    assert.strictEqual(first.status, 200);
    assert.ok(!text.includes('qwen'), 'replies must be encrypted');
    assert.strictEqual(first.headers.get('access-control-allow-origin'), '*');
    // The same request again (a replay) is refused.
    assert.strictEqual((await fetch(url, { method: 'POST', body })).status, 403);
    // So is an old one.
    const old = await lock(await linkKey(key), { op: 'models', ts: Date.now() - 60 * 60 * 1000, nonce: 'n2' });
    assert.strictEqual((await fetch(url, { method: 'POST', body: old })).status, 403);

    // A device with another sync passphrase gets a clear message.
    const stranger = client(syncKey(), { desk: pc.addr });
    await assert.rejects(stranger.listModels(), /didn't accept this phone/);
  } finally {
    await pc.server.close();
  }
});

test('finds the computer on whichever address answers, and explains when none does', async () => {
  const key = syncKey();
  const pc = await computer(key);
  try {
    // 192.0.2.1 is a documentation address that never answers.
    // (A short probe time, so the one to 192.0.2.1 doesn't outlive the test for long.)
    const phone = client(key, { desk: { ...pc.addr, addrs: ['192.0.2.1', '127.0.0.1'] } }, { probeMs: 500 });
    assert.strictEqual((await phone.listModels()).length, 2);
  } finally {
    await pc.server.close();
  }
  const phone = client(key, { desk: pc.addr });
  await assert.rejects(phone.listModels(), /Couldn't reach Desk/);
  await assert.rejects(client(key, {}).listModels(), /No computer is sharing/);
  await assert.rejects(client(null, { desk: pc.addr }).listModels(), /Set up sync on this phone first/);
});

test('stopping a reply on the phone stops it on the computer; errors come through', async () => {
  const key = syncKey();
  const pc = await computer(key, { words: Array(40).fill(' word'), delay: 20 });
  try {
    const phone = client(key, { desk: pc.addr });
    await phone.listModels();
    const controller = new AbortController();
    const pieces = [];
    const run = phone.streamChat({}, { model: 'qwen3.5:9b (Desk)', messages: [] }, (t) => {
      pieces.push(t);
      if (pieces.length === 2) controller.abort();
    }, controller.signal);
    await assert.rejects(run);
    await sleep(100);
    assert.strictEqual(pc.seen.aborted, 1);

    await assert.rejects(phone.streamChat({}, { model: 'nope (Desk)', messages: [] }, () => {}), /isn't available/);
  } finally {
    await pc.server.close();
  }
  const pc2 = await computer(key, { words: ['x'] });
  try {
    const phone = client(key, { desk: pc2.addr });
    const models = await phone.listModels();
    assert.ok(models.length);
    // An error from the model on the computer is shown as is.
    const broken = remoteComputers({ getKey: async () => key, getComputers: async () => ({ desk: pc2.addr }) });
    await broken.listModels();
    const call = await broken.locate(pc2.addr);
    await assert.rejects(broken.call(call, 'chat', { provider: 'ollama', req: { model: 'broken' } }), /model "broken" not found/);
  } finally {
    await pc2.server.close();
  }
});

test('lists the computer\'s network addresses, LAN first', () => {
  const addrs = localAddresses({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    tailscale0: [{ family: 'IPv4', address: '100.101.102.103', internal: false }],
    en0: [
      { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv4', address: '192.168.1.23', internal: false }
    ],
    bad: [{ family: 'IPv4', address: '169.254.3.4', internal: false }]
  });
  assert.deepStrictEqual(addrs, ['192.168.1.23', '100.101.102.103']);
});

test('a computer publishes itself through synced settings; the app window can\'t overwrite it', async () => {
  const storage = await Storage.open(nodeFsBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'balimda-remote-'))));
  const stale = await storage.getSettings();
  let changes = 0;
  storage.onChange(() => changes++);
  assert.strictEqual(await storage.publishComputer('desk', { id: 'desk', name: 'Desk', addrs: ['192.168.1.23'], port: 47811, enabled: true }), true);
  assert.strictEqual(changes, 1);
  // Same again: nothing to sync.
  assert.strictEqual(await storage.publishComputer('desk', { id: 'desk', name: 'Desk', addrs: ['192.168.1.23'], port: 47811, enabled: true }), false);
  const shared = await storage.getSharedSettings();
  assert.strictEqual(shared.data.computers.desk.name, 'Desk');

  // The window saves settings it loaded before the computer was published.
  stale.theme = 'dark';
  await storage.saveSettings(stale);
  const after = await storage.getSettings();
  assert.strictEqual(after.theme, 'dark');
  assert.strictEqual(after.computers.desk.addrs[0], '192.168.1.23');
  assert.strictEqual((await storage.getSharedSettings()).modifiedAt, shared.modifiedAt, 'a local-only change is not a shared change');
});

test('a phone that drops the connection mid-request doesn\'t upset the computer', async () => {
  const key = syncKey();
  const pc = await computer(key);
  const failures = [];
  const onFailure = (err) => failures.push(err);
  process.on('unhandledRejection', onFailure);
  process.on('uncaughtException', onFailure);
  try {
    const net = require('net');
    await new Promise((resolve) => {
      const sock = net.connect(pc.server.port, '127.0.0.1', () => {
        sock.write(`POST ${PATH} HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 1000\r\n\r\nhalf a request`);
        setTimeout(() => { sock.destroy(); resolve(); }, 50);
      });
    });
    await sleep(100);
    assert.deepStrictEqual(failures, []);
    // Still answers the next request.
    assert.deepStrictEqual(await client(key, { desk: pc.addr }).listModels(), ['claude-opus-5 (Desk, Anthropic Claude)', 'qwen3.5:9b (Desk)']);
  } finally {
    process.off('unhandledRejection', onFailure);
    process.off('uncaughtException', onFailure);
    await pc.server.close();
  }
});

test('a reply cut off halfway says the connection was lost, and keeps what came', async () => {
  const key = syncKey();
  let started;
  const onStart = new Promise((r) => { started = r; });
  const server = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    getKey: async () => linkKey(key),
    handlers: {
      hello: async () => ({}),
      models: async () => [{ provider: 'ollama', label: 'Ollama', short: 'Ollama', models: ['m'] }],
      chat: async (_msg, { emit, signal }) => {
        emit({ t: 'delta', text: 'Day 1: ' });
        started();
        await new Promise((r) => signal.addEventListener('abort', r));
        throw new Error('aborted');
      }
    }
  });
  const phone = client(key, { desk: { id: 'desk', name: 'Desk', addrs: ['127.0.0.1'], port: server.port, enabled: true } });
  await phone.listModels();
  const pieces = [];
  const run = phone.streamChat({}, { model: 'm (Desk)', messages: [] }, (t) => pieces.push(t));
  await onStart;
  await sleep(100);
  await server.close(); // e.g. the computer went to sleep
  await assert.rejects(run, /connection to Desk was lost while it was replying/);
  assert.strictEqual(pieces.join(''), 'Day 1: ');
});

test('a computer that goes quiet after its heartbeat is reported, not waited on for ever', async () => {
  const key = syncKey();
  const server = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    heartbeatMs: 60 * 60 * 1000,
    getKey: async () => linkKey(key),
    handlers: {
      hello: async () => ({}),
      models: async () => [{ provider: 'ollama', label: 'Ollama', short: 'Ollama', models: ['m'] }],
      chat: async (_msg, { emit, signal }) => {
        emit({ t: 'ping' });
        await new Promise((r) => signal.addEventListener('abort', r));
        throw new Error('aborted');
      }
    }
  });
  try {
    const phone = client(key, { desk: { id: 'desk', name: 'Desk', addrs: ['127.0.0.1'], port: server.port, enabled: true } }, { quietMs: 300 });
    await phone.listModels();
    await assert.rejects(phone.streamChat({}, { model: 'm (Desk)', messages: [] }, () => {}), /stopped answering/);
  } finally {
    await server.close();
  }
});

test('heartbeats keep a slow model\'s reply going', async () => {
  const key = syncKey();
  const server = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    heartbeatMs: 50,
    getKey: async () => linkKey(key),
    handlers: {
      hello: async () => ({}),
      models: async () => [{ provider: 'ollama', label: 'Ollama', short: 'Ollama', models: ['m'] }],
      chat: async (_msg, { emit }) => {
        await sleep(500); // thinking, with heartbeats and no text
        emit({ t: 'delta', text: 'Done' });
        return { text: 'Done', stopReason: 'end_turn' };
      }
    }
  });
  try {
    const phone = client(key, { desk: { id: 'desk', name: 'Desk', addrs: ['127.0.0.1'], port: server.port, enabled: true } }, { quietMs: 300 });
    await phone.listModels();
    const pieces = [];
    const r = await phone.streamChat({}, { model: 'm (Desk)', messages: [] }, (t) => pieces.push(t));
    assert.strictEqual(r.text, 'Done');
    assert.strictEqual(pieces.join(''), 'Done');
  } finally {
    await server.close();
  }
});
