// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

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

// Plays Hermes' runs API (gateway/platforms/api_server_runs.py): numbered
// events, replayed after Last-Event-ID, and a pollable status once the run's
// live events are gone.
function fakeHermesRuns({ script = 'drop' } = {}) {
  const seen = { posts: [], lastIds: [], stops: 0, approvals: [], steers: [] };
  const run = { status: 'running', output: 'Freed 2.4 GB.' };
  const events = [
    { event: 'reasoning.available', text: 'Look for caches.' },
    { event: 'tool.started', tool: 'terminal', preview: 'du -sh ~/Projects', tool_call_id: 'c1' },
    { event: 'tool.completed', tool: 'terminal', tool_call_id: 'c1', error: false },
    { event: 'message.delta', delta: 'Freed ' },
    { event: 'approval.request', run_id: 'run_1', request_id: 'a1', command: 'rm -rf old/', description: 'delete', choices: ['once', 'deny'] },
    { event: 'message.delta', delta: '2.4 GB.' },
    { event: 'run.completed', output: 'Freed 2.4 GB.' }
  ].map((e, seq) => ({ ...e, run_id: 'run_1', seq }));
  let connections = 0;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401);
      return res.end();
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method === 'POST' && req.url === '/v1/runs') {
        seen.posts.push({ body: JSON.parse(body), idempotency: req.headers['idempotency-key'] });
        return send(202, { run_id: 'run_1', status: 'started' });
      }
      if (req.url === '/v1/runs/run_1/stop') {
        seen.stops++;
        run.status = 'cancelled';
        return send(200, { status: 'stopping' });
      }
      if (req.url === '/v1/runs/run_1/steer') {
        if (run.status !== 'running') return send(409, { error: { message: 'Run is not currently accepting steer input' } });
        seen.steers.push(JSON.parse(body).input);
        return send(200, { object: 'hermes.run.steer', run_id: 'run_1', accepted: true });
      }
      if (req.url === '/v1/runs/run_1/approval') {
        seen.approvals.push(JSON.parse(body));
        return send(200, { ok: true });
      }
      if (req.url === '/v1/runs/run_1') return send(200, { object: 'hermes.run', run_id: 'run_1', ...run });
      if (req.url !== '/v1/runs/run_1/events') return send(404, { error: { message: 'not found' } });
      connections++;
      seen.lastIds.push(req.headers['last-event-id'] ?? null);
      if (script === 'gone' && connections > 1) {
        // Finished while away, and its live events are gone: the status has the answer.
        run.status = 'completed';
        return send(404, { error: { message: 'Run not found' } });
      }
      if (script === 'truncated' && connections > 1) {
        // Too much happened while away: Hermes can't replay it all.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ event: 'replay.truncated', run_id: 'run_1', oldest_retained_seq: 900 })}\n\n`);
        res.write(`id: 950\ndata: ${JSON.stringify({ event: 'run.completed', run_id: 'run_1', seq: 950, output: 'Removed old caches: 2.4 GB.' })}\n\n`);
        return res.end(': stream closed\n\n');
      }
      if (script === 'picture') {
        // Hermes with pictures in the finished answer (the streamed text has the path).
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const pic = '![image](data:image/png;base64,iVBORw0KGgo=)';
        for (const [seq, e] of [
          { event: 'message.delta', delta: 'MEDIA:/home/me/tv.png\n\nTaken just now.' },
          { event: 'run.completed', output: `${pic}\n\nTaken just now.` }
        ].entries()) res.write(`id: ${seq}\ndata: ${JSON.stringify({ ...e, run_id: 'run_1', seq })}\n\n`);
        return res.end(': stream closed\n\n');
      }
      if (script === 'steer') {
        // The agent reads what the user sent after its step; one sent too late comes back.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`id: 0\ndata: ${JSON.stringify({ event: 'message.delta', run_id: 'run_1', seq: 0, delta: 'Checking the disk. ' })}\n\n`);
        while (seen.steers.length < 2) await sleep(5);
        res.write(`id: 1\ndata: ${JSON.stringify({ event: 'message.delta', run_id: 'run_1', seq: 1, delta: `Also ${seen.steers[0]}.` })}\n\n`);
        run.status = 'completed';
        res.write(`id: 2\ndata: ${JSON.stringify({ event: 'run.completed', run_id: 'run_1', seq: 2, output: `Also ${seen.steers[0]}.`, pending_steer: seen.steers[1] })}\n\n`);
        return res.end(': stream closed\n\n');
      }
      if (script === 'failed') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`id: 0\ndata: ${JSON.stringify({ event: 'run.failed', run_id: 'run_1', seq: 0, error: 'Model provider error' })}\n\n`);
        return res.end(': stream closed\n\n');
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': open\n\n');
      const from = Number(req.headers['last-event-id'] ?? -1) + 1;
      for (const e of events.slice(from)) {
        // The first time, the connection drops in the middle (the phone left the app).
        if (connections === 1 && e.seq === 4 && script !== 'stop') {
          await sleep(20);
          return res.destroy();
        }
        if (script === 'stop' && e.seq === 4) return; // waits until stopped
        if (script === 'gone' && e.seq === 4) return res.destroy();
        res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
        await sleep(5);
      }
      res.end(': stream closed\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

test('Hermes runs: a dropped connection reconnects and picks up where it left off', async () => {
  const h = await fakeHermesRuns();
  try {
    const cfg = { baseUrl: h.url, apiKey: KEY };
    const infos = [];
    let text = '';
    const result = await hermes.streamChat(cfg, {
      model: 'hermes-agent', system: 'Be brief.',
      messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello!' }, { role: 'user', content: 'Clean my disk' }]
    }, (piece) => { text += piece; }, undefined, (info) => infos.push(info));
    assert.strictEqual(text, '<think>Look for caches.</think>\n\nFreed 2.4 GB.');
    assert.strictEqual(result.text, text);
    // Reconnected once, after the last event it had (3).
    assert.deepStrictEqual(h.seen.lastIds, [null, '3']);
    // The run's id comes first (the app keeps it, to follow the run again after being closed).
    assert.deepStrictEqual(infos[0], { kind: 'run', runId: 'run_1' });
    assert.deepStrictEqual(infos.slice(1).map((i) => `${i.kind}:${i.status || i.command || i.text}`), [
      'tool:running', 'tool:completed', 'status:Reconnecting to Hermes…', 'status:', 'approval:rm -rf old/'
    ]);
    assert.strictEqual(infos.find((i) => i.kind === 'approval').approvalId, 'a1');
    // The chat went as a run: the new message, the earlier ones, and the instructions.
    const post = h.seen.posts[0];
    assert.deepStrictEqual(post.body, {
      model: 'hermes-agent', input: 'Clean my disk', instructions: 'Be brief.',
      conversation_history: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello!' }]
    });
    assert.ok(post.idempotency);
  } finally {
    h.server.close();
  }
});

test('Hermes runs: messages sent while the agent works, and one sent too late', async () => {
  const h = await fakeHermesRuns({ script: 'steer' });
  try {
    const steering = { send: null };
    const cfg = { baseUrl: h.url, apiKey: KEY };
    const done = hermes.streamChat(cfg, { model: 'hermes-agent', messages: [{ role: 'user', content: 'Clean' }], steering }, () => {});
    while (!steering.send) await sleep(5);
    assert.strictEqual(await steering.send('the Downloads folder'), true);
    assert.strictEqual(await steering.send('and the logs'), true);
    const result = await done;
    assert.deepStrictEqual(h.seen.steers, ['the Downloads folder', 'and the logs']);
    assert.strictEqual(result.text, 'Checking the disk. Also the Downloads folder.');
    // The agent finished before reading the second: the app sends it next.
    assert.strictEqual(result.pendingSteer, 'and the logs');
    // Once the run is over, nothing more is taken.
    assert.strictEqual(steering.send, null);
  } finally {
    h.server.close();
  }
});

test('Hermes runs: a run that is already going (the app was closed) is followed again, not started again', async () => {
  const h = await fakeHermesRuns({ script: 'stop-free' });
  try {
    const infos = [];
    let text = '';
    const result = await hermes.streamChat({ baseUrl: h.url, apiKey: KEY }, { model: 'hermes-agent', messages: [{ role: 'user', content: 'Clean my disk' }], resumeRun: 'run_1' },
      (piece) => { text += piece; }, undefined, (info) => infos.push(info));
    assert.strictEqual(h.seen.posts.length, 0, 'no new run');
    assert.ok(!infos.some((i) => i.kind === 'run'));
    assert.strictEqual(result.text, '<think>Look for caches.</think>\n\nFreed 2.4 GB.');
  } finally {
    h.server.close();
  }
});

test('Hermes runs: finished while away (status only), failed, and Stop', async () => {
  let h = await fakeHermesRuns({ script: 'gone' });
  try {
    let text = '';
    await hermes.streamChat({ baseUrl: h.url, apiKey: KEY }, { model: 'hermes-agent', messages: [{ role: 'user', content: 'Clean' }] },
      (piece) => { text += piece; });
    // It had "Freed " live; the rest comes from the finished run's status.
    assert.strictEqual(text, '<think>Look for caches.</think>\n\nFreed 2.4 GB.');
  } catch (err) {
    assert.fail(err);
  } finally {
    h.server.close();
  }

  h = await fakeHermesRuns({ script: 'truncated' });
  try {
    const infos = [];
    const result = await hermes.streamChat({ baseUrl: h.url, apiKey: KEY }, { model: 'hermes-agent', messages: [{ role: 'user', content: 'Clean' }] },
      () => {}, undefined, (info) => infos.push(info));
    // Some of the reply was missed: the app gets the finished answer instead.
    const replaced = infos.find((i) => i.kind === 'replace');
    assert.strictEqual(replaced.text, '<think>Look for caches.</think>\n\nRemoved old caches: 2.4 GB.');
    assert.strictEqual(result.text, replaced.text);
  } finally {
    h.server.close();
  }

  h = await fakeHermesRuns({ script: 'picture' });
  try {
    const infos = [];
    const result = await hermes.streamChat({ baseUrl: h.url, apiKey: KEY }, { model: 'hermes-agent', messages: [{ role: 'user', content: 'Screenshot' }] },
      () => {}, undefined, (info) => infos.push(info));
    // The finished answer, with the picture inline, replaces the path.
    assert.strictEqual(result.text, '![image](data:image/png;base64,iVBORw0KGgo=)\n\nTaken just now.');
    assert.strictEqual(infos.find((i) => i.kind === 'replace').text, result.text);
  } finally {
    h.server.close();
  }

  h = await fakeHermesRuns({ script: 'failed' });
  try {
    await assert.rejects(hermes.streamChat({ baseUrl: h.url, apiKey: KEY }, { model: 'hermes-agent', messages: [{ role: 'user', content: 'hi' }] }, () => {}),
      /Hermes couldn't finish: Model provider error/);
  } finally {
    h.server.close();
  }

  h = await fakeHermesRuns({ script: 'stop' });
  try {
    const controller = new AbortController();
    let text = '';
    const done = hermes.streamChat({ baseUrl: h.url, apiKey: KEY }, { model: 'hermes-agent', messages: [{ role: 'user', content: 'Clean' }] },
      (piece) => {
        text += piece;
        if (text.includes('Freed')) controller.abort();
      }, controller.signal);
    await assert.rejects(done, { name: 'AbortError' });
    await sleep(50);
    assert.strictEqual(h.seen.stops, 1);
  } finally {
    h.server.close();
  }
});

// Newer Hermes (its session runtime, gateway/platforms/api_server_authority_runs.py):
// an answer must be exactly { request_id, execution_generation, choice }, and
// GET /v1/runs/{id} reports the turn's generation and the questions it waits on.
function fakeAuthorityHermes({ strict = true } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method === 'GET' && req.url === '/v1/runs/run_1') {
        return json(200, { run_id: 'run_1', status: 'waiting_for_approval', execution_generation: 7,
          pending_controls: [{ kind: 'approval', prompt_id: 'req_9', execution_generation: 7, choices: ['once', 'deny'] }] });
      }
      if (req.method === 'POST' && req.url === '/v1/runs/run_1/approval') {
        const b = JSON.parse(body);
        seen.push(b);
        const keys = Object.keys(b).sort().join(',');
        if (strict && keys !== 'choice,execution_generation,request_id') return json(400, { error: { message: 'invalid_params', code: 'invalid_params' } });
        if (!strict && 'execution_generation' in b) return json(400, { error: { message: 'Unexpected field' } });
        if (strict && (b.execution_generation !== 7 || b.request_id !== 'req_9')) return json(409, { error: { message: 'stale_generation' } });
        return json(200, { run_id: 'run_1', choice: b.choice });
      }
      json(404, { error: { message: 'not found' } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

test('Hermes approvals: newer Hermes gets the turn\'s generation; an answer without it looks it up; older Hermes keeps the old form', async () => {
  const hermes = hermesProvider();
  const strict = await fakeAuthorityHermes();
  try {
    const cfg = { baseUrl: strict.url, apiKey: KEY };
    // The generation came with the question.
    assert.strictEqual(await hermes.approve(cfg, { runId: 'run_1', choice: 'once', approvalId: 'req_9', generation: 7 }), true);
    assert.deepStrictEqual(strict.seen.at(-1), { request_id: 'req_9', execution_generation: 7, choice: 'once' });
    // Asked before the app kept it (or passed on without it): refused, read from the run, sent again.
    assert.strictEqual(await hermes.approve(cfg, { runId: 'run_1', choice: 'deny', approvalId: 'req_9' }), true);
    assert.deepStrictEqual(strict.seen.slice(-2), [{ choice: 'deny', request_id: 'req_9' }, { request_id: 'req_9', execution_generation: 7, choice: 'deny' }]);
    // No question id either: the only one waiting.
    assert.strictEqual(await hermes.approve(cfg, { runId: 'run_1', choice: 'once' }), true);
    assert.deepStrictEqual(strict.seen.at(-1), { request_id: 'req_9', execution_generation: 7, choice: 'once' });
    // A question that isn't waiting any more: the error is Hermes's own.
    await assert.rejects(hermes.approve(cfg, { runId: 'run_1', choice: 'once', approvalId: 'req_8' }), /HTTP 400: invalid_params/);
  } finally {
    strict.server.close();
  }
  const old = await fakeAuthorityHermes({ strict: false });
  try {
    assert.strictEqual(await hermes.approve({ baseUrl: old.url, apiKey: KEY }, { runId: 'run_1', choice: 'once', approvalId: 'req_9' }), true);
    assert.deepStrictEqual(old.seen, [{ choice: 'once', request_id: 'req_9' }]);
  } finally {
    old.server.close();
  }
});

test('Hermes approvals: the turn\'s generation is read from the question', async () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'providers.js'), 'utf8');
  // Both ways Hermes asks (runs and the chat stream) keep it.
  assert.strictEqual((src.match(/generation: Number\.isInteger\(evt\.execution_generation\) \? evt\.execution_generation : null/g) || []).length, 2);
});
