// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { PROVIDERS } = require('../src/providers');
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
    const phone = remoteComputers({ getKey: async () => syncKey, getComputers: async () => ({ desk: { id: 'desk', name: 'Desk', addrs: ['127.0.0.1'], port: pc.port, enabled: true } }), probeMs: 500 });
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
