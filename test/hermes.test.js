// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { PROVIDERS, hermesProvider } = require('../src/providers');
const { makeNativeFetch } = require('../src/native-fetch');
const { linkKey, remoteComputers } = require('../src/remote');
const { startRemoteServer } = require('../src/remote-server');
const { toBase64 } = require('../src/sync');

const KEY = 'hermes-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = (data, event) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
const chunk = (delta, finish = null) => frame({ id: 'chatcmpl-run1', object: 'chat.completion.chunk', model: 'hermes-agent', choices: [{ index: 0, delta, finish_reason: finish }] });

// Plays Hermes Agent's API server (gateway/platforms/api_server*.py): the same
// SSE frames, a keepalive comment, and the approval endpoint.
function fakeHermes({ script = 'full' } = {}) {
  const seen = { chats: [], approvals: [], auth: [] };
  let resolveApproval;
  const server = http.createServer((req, res) => {
    // Like Hermes' CORS middleware: a web page's request (it has an Origin)
    // is refused unless API_SERVER_CORS_ORIGINS lists that origin.
    seen.origins = [...(seen.origins || []), req.headers.origin];
    if (req.headers.origin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Origin not allowed' } }));
    }
    seen.auth.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      if (req.url === '/v1/models') return res.end(JSON.stringify({ object: 'list', data: [{ id: 'hermes-agent', object: 'model' }] }));
      if (req.url === '/v1/runs/chatcmpl-run1/approval') {
        seen.approvals.push(JSON.parse(body));
        res.end(JSON.stringify({ ok: true }));
        if (resolveApproval) resolveApproval();
        return;
      }
      if (req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        return res.end();
      }
      seen.chats.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant' }));
      if (script === 'fail') {
        res.write(chunk({}, 'error'));
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.write(chunk({ reasoning_content: 'I should look at the files.' }));
      res.write(': keepalive\n\n');
      res.write(frame({ tool: 'terminal', emoji: '💻', label: 'ls src/', toolCallId: 'call_1', status: 'running' }, 'hermes.tool.progress'));
      await sleep(10);
      res.write(frame({ tool: 'terminal', toolCallId: 'call_1', status: 'completed' }, 'hermes.tool.progress'));
      res.write(frame({ kind: 'provider_wait', text: 'Waiting for the model…' }, 'hermes.status'));
      // Asks before deleting, and waits for the answer.
      res.write(frame({ command: 'rm -rf build/', description: 'recursive delete', pattern_key: 'rm_rf', allow_permanent: true, allow_session: true, event: 'approval.request', run_id: 'chatcmpl-run1', timestamp: 1, choices: ['once', 'session', 'always', 'deny'] }, 'approval.request'));
      await new Promise((r) => { resolveApproval = r; });
      res.write(frame({ tool: 'terminal', emoji: '💻', label: 'rm -rf build/', toolCallId: 'call_2', status: 'running' }, 'hermes.tool.progress'));
      res.write(frame({ tool: 'terminal', toolCallId: 'call_2', status: 'completed' }, 'hermes.tool.progress'));
      res.write(chunk({ content: 'Cleaned the build folder. ' }));
      res.write(chunk({ content: 'Your project has src/ and tests/.' }));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

const hermes = PROVIDERS.hermes.impl;

test('Hermes: streams thinking, tool steps, status and an approval, and passes the answer back', async () => {
  const h = await fakeHermes();
  try {
    const cfg = { baseUrl: h.url, apiKey: KEY };
    assert.deepStrictEqual(await hermes.listModels(cfg), ['hermes-agent']);
    const infos = [];
    let text = '';
    const result = await hermes.streamChat(cfg, { model: 'hermes-agent', system: 'Be brief.', messages: [{ role: 'user', content: 'Clean up and list my project' }] },
      (piece) => { text += piece; },
      undefined,
      (info) => {
        infos.push(info);
        // Answer the approval the way the app's button does.
        if (info.kind === 'approval') hermes.approve(cfg, { runId: info.runId, choice: 'once', approvalId: info.approvalId });
      });
    assert.strictEqual(result.text, text);
    assert.strictEqual(text, '<think>I should look at the files.</think>\n\nCleaned the build folder. Your project has src/ and tests/.');
    assert.strictEqual(result.stopReason, 'end_turn');
    assert.deepStrictEqual(infos.map((i) => `${i.kind}:${i.status || i.command || i.text}`), [
      'tool:running', 'tool:completed', 'status:Waiting for the model…', 'approval:rm -rf build/', 'tool:running', 'tool:completed'
    ]);
    const approval = infos.find((i) => i.kind === 'approval');
    assert.deepStrictEqual(approval.choices, ['once', 'session', 'always', 'deny']);
    assert.strictEqual(approval.description, 'recursive delete');
    assert.deepStrictEqual(h.seen.approvals, [{ choice: 'once' }]);
    // The system prompt and the chat went to Hermes, with the key.
    assert.deepStrictEqual(h.seen.chats[0].messages.map((m) => m.role), ['system', 'user']);
    assert.strictEqual(h.seen.chats[0].stream, true);
  } finally {
    h.server.close();
  }
});

test('Hermes: clear errors for a wrong key and a failed run', async () => {
  const h = await fakeHermes({ script: 'fail' });
  try {
    await assert.rejects(hermes.listModels({ baseUrl: h.url, apiKey: 'wrong' }), /didn't accept the API key/);
    await assert.rejects(hermes.streamChat({ baseUrl: h.url, apiKey: KEY }, { model: 'hermes-agent', messages: [{ role: 'user', content: 'hi' }] }, () => {}),
      /Hermes stopped before answering \(error\)/);
  } finally {
    h.server.close();
  }
});

test('Hermes through "On your computer": the phone sees the steps and answers approvals', async () => {
  const h = await fakeHermes();
  const syncKey = toBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const cfg = { baseUrl: h.url, apiKey: KEY };
  // The computer's side, as main.js wires it.
  const pc = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    getKey: async () => linkKey(syncKey),
    handlers: {
      hello: async () => ({ app: 'balimda', name: 'Desk' }),
      models: async () => [{ provider: 'hermes', label: 'Hermes Agent', short: 'Hermes Agent', models: await hermes.listModels(cfg) }],
      chat: async (msg, { emit, signal }) => hermes.streamChat(cfg, msg.req, (text) => emit({ t: 'delta', text }), signal, (info) => emit({ t: 'info', info })),
      approve: async (msg) => hermes.approve(cfg, msg.payload)
    }
  });
  try {
    const phone = remoteComputers({ getKey: async () => syncKey, getComputers: async () => ({ desk: { id: 'desk', name: 'Desk', addrs: ['127.0.0.1'], port: pc.port, enabled: true } }) });
    const name = 'hermes-agent (Desk, Hermes Agent)';
    assert.deepStrictEqual(await phone.listModels(), [name]);
    const kinds = [];
    let text = '';
    await phone.streamChat({}, { model: name, messages: [{ role: 'user', content: 'go' }] }, (p) => { text += p; }, undefined, (info) => {
      kinds.push(info.kind);
      if (info.kind === 'approval') phone.approve(name, { runId: info.runId, choice: 'deny' });
    });
    assert.ok(text.endsWith('Your project has src/ and tests/.'));
    assert.deepStrictEqual(kinds, ['tool', 'tool', 'status', 'approval', 'tool', 'tool']);
    assert.deepStrictEqual(h.seen.approvals, [{ choice: 'deny' }]);
  } finally {
    await pc.close();
    h.server.close();
  }
});

// The phone's "Net" plugin (NetPlugin.java / NetPlugin.swift), played by
// Node's own http: no Origin header, the answer passed on piece by piece.
// `early` sends the whole answer before request() returns, which the phone's
// bridge may also do.
function fakeNet({ early = false } = {}) {
  const listeners = new Set();
  const running = new Map();
  const emit = (evt) => setImmediate(() => { for (const l of listeners) l(evt); });
  const net = {
    calls: [],
    cancelled: [],
    async addListener(name, fn) {
      assert.strictEqual(name, 'net');
      listeners.add(fn);
      return { remove: async () => listeners.delete(fn) };
    },
    request({ id, url, method, headers, body }) {
      net.calls.push({ id, url, method, headers, body });
      return new Promise((resolve, reject) => {
        let answered = false;
        const req = http.request(url, { method, headers }, (res) => {
          answered = true;
          const head = { status: res.statusCode, headers: res.headers };
          const pieces = [];
          res.on('data', (b) => (early ? pieces.push(b) : emit({ id, data: b.toString('base64') })));
          res.on('end', () => {
            if (early) {
              for (const b of pieces) emit({ id, data: b.toString('base64') });
              emit({ id, done: true });
              setTimeout(() => resolve(head), 20);
            } else {
              emit({ id, done: true });
            }
          });
          res.on('error', (err) => emit({ id, error: err.message }));
          if (!early) resolve(head);
        });
        running.set(id, req);
        req.on('error', (err) => (answered ? emit({ id, error: err.message }) : reject(new Error(`Couldn't connect to the server (${err.code})`))));
        if (body != null) req.write(body);
        req.end();
      });
    },
    async cancel({ id }) {
      net.cancelled.push(id);
      const req = running.get(id);
      if (req) req.destroy();
    }
  };
  return net;
}

test('Hermes from the phone directly: refused through the web view, works through the phone\'s own network code', async () => {
  const h = await fakeHermes();
  try {
    const cfg = { baseUrl: h.url, apiKey: KEY };
    // The web view adds the app's Origin to every request.
    const webView = hermesProvider((url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers || {}), Origin: 'https://localhost' } }));
    await assert.rejects(webView.listModels(cfg), /didn't accept|HTTP 403/);

    const net = fakeNet();
    const phone = hermesProvider(makeNativeFetch(net));
    assert.deepStrictEqual(await phone.listModels(cfg), ['hermes-agent']);
    const kinds = [];
    let text = '';
    const result = await phone.streamChat(cfg, { model: 'hermes-agent', messages: [{ role: 'user', content: 'Clean up and list my project — مرحبا' }] },
      (piece) => { text += piece; }, undefined,
      (info) => {
        kinds.push(info.kind);
        if (info.kind === 'approval') phone.approve(cfg, { runId: info.runId, choice: 'once', approvalId: info.approvalId });
      });
    assert.strictEqual(text, '<think>I should look at the files.</think>\n\nCleaned the build folder. Your project has src/ and tests/.');
    assert.strictEqual(result.stopReason, 'end_turn');
    assert.deepStrictEqual(kinds, ['tool', 'tool', 'status', 'approval', 'tool', 'tool']);
    assert.deepStrictEqual(h.seen.approvals, [{ choice: 'once' }]);
    assert.strictEqual(h.seen.chats[0].messages[0].content, 'Clean up and list my project — مرحبا');
    // What the plugin was asked to do.
    const chat = net.calls.find((c) => c.url.endsWith('/chat/completions'));
    assert.strictEqual(chat.method, 'POST');
    assert.strictEqual(chat.headers.authorization, `Bearer ${KEY}`);
    assert.strictEqual(chat.headers['content-type'], 'application/json');
    assert.strictEqual(typeof chat.body, 'string');
    assert.ok(h.seen.origins.slice(1).every((o) => o === undefined), 'no Origin from the phone\'s own requests');

    // A wrong key still gets Hermes' own answer.
    await assert.rejects(phone.listModels({ ...cfg, apiKey: 'wrong' }), /didn't accept the API key/);
  } finally {
    h.server.close();
  }
});

test('Phone network code: an answer that arrives before request() returns, Stop, and no server', async () => {
  const h = await fakeHermes();
  try {
    const cfg = { baseUrl: h.url, apiKey: KEY };
    // The whole answer comes in before request() resolves.
    const early = hermesProvider(makeNativeFetch(fakeNet({ early: true })));
    assert.deepStrictEqual(await early.listModels(cfg), ['hermes-agent']);

    // Stop while Hermes waits for an approval: the request is cancelled.
    const net = fakeNet();
    const phone = hermesProvider(makeNativeFetch(net));
    const controller = new AbortController();
    const reply = phone.streamChat(cfg, { model: 'hermes-agent', messages: [{ role: 'user', content: 'go' }] }, () => {}, controller.signal,
      (info) => { if (info.kind === 'approval') controller.abort(); });
    await assert.rejects(reply, (err) => err.name === 'AbortError');
    await sleep(20);
    assert.strictEqual(net.cancelled.length, 1);

    // Already stopped: nothing is sent.
    const calls = net.calls.length;
    await assert.rejects(makeNativeFetch(net)(`${h.url}/models`, { signal: AbortSignal.abort() }), (err) => err.name === 'AbortError');
    assert.strictEqual(net.calls.length, calls);

    // No server: a network error, like fetch's.
    const port = h.server.address().port;
    await new Promise((r) => {
      h.server.close(r);
      h.server.closeAllConnections();
    });
    await assert.rejects(makeNativeFetch(fakeNet())(`http://127.0.0.1:${port}/v1/models`), (err) => err instanceof TypeError && err.explained && /Couldn't connect/.test(err.message));
  } finally {
    if (h.server.listening) h.server.close();
  }
});
