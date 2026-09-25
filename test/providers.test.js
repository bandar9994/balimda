// Balimda — © 2026 Bandar. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar" credit; no rebranding.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { PROVIDERS, normalizeMessages } = require('../src/providers');

function server(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(JSON.parse(data || '{}')));
  });
}

test('normalizeMessages merges roles and starts with user', () => {
  const out = normalizeMessages([
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: '  ' },
    { role: 'assistant', content: 'c' }
  ]);
  assert.deepStrictEqual(out, [
    { role: 'user', content: 'a\n\nb' },
    { role: 'assistant', content: 'c' }
  ]);
});

test('ollama lists models and streams NDJSON', async () => {
  let seen;
  const s = await server(async (req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.2' }] }));
    seen = await readBody(req);
    res.write(JSON.stringify({ message: { content: 'Hel' }, done: false }) + '\n');
    res.write(JSON.stringify({ message: { content: 'lo' }, done: false }) + '\n');
    res.end(JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' }) + '\n');
  });
  const cfg = { baseUrl: s.url };
  assert.deepStrictEqual(await PROVIDERS.ollama.impl.listModels(cfg), ['llama3.2', 'qwen3:8b']);
  const deltas = [];
  const r = await PROVIDERS.ollama.impl.streamChat(cfg,
    { model: 'llama3.2', system: 'be nice', messages: [{ role: 'user', content: 'hi' }], temperature: 0.5 },
    (d) => deltas.push(d));
  s.close();
  assert.strictEqual(r.text, 'Hello');
  assert.deepStrictEqual(deltas, ['Hel', 'lo']);
  assert.deepStrictEqual(seen.messages[0], { role: 'system', content: 'be nice' });
  assert.strictEqual(seen.options.temperature, 0.5);
});

test('openai-compatible streams SSE and reports errors', async () => {
  const s = await server(async (req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
    const body = await readBody(req);
    if (body.model === 'missing') {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: { message: 'model not found' } }));
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":" there"},"finish_reason":"length"}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const cfg = { baseUrl: `${s.url}/v1/` };
  const impl = PROVIDERS.openaiCompatible.impl;
  assert.deepStrictEqual(await impl.listModels(cfg), ['local-model']);
  const r = await impl.streamChat(cfg, { model: 'local-model', messages: [{ role: 'user', content: 'x' }] }, () => {});
  assert.strictEqual(r.text, 'Hi there');
  assert.strictEqual(r.stopReason, 'max_tokens');
  await assert.rejects(impl.streamChat(cfg, { model: 'missing', messages: [] }, () => {}), /404: model not found/);
  s.close();
});

test('abort stops a stream', async () => {
  const s = await server((req, res) => {
    res.write(JSON.stringify({ message: { content: 'a' } }) + '\n');
    // never ends
  });
  const controller = new AbortController();
  const p = PROVIDERS.ollama.impl.streamChat({ baseUrl: s.url }, { model: 'm', messages: [] },
    () => controller.abort(), controller.signal);
  await assert.rejects(p);
  s.closeAllConnections?.();
  s.close();
});

test('anthropic without a key gives a helpful error', async () => {
  await assert.rejects(PROVIDERS.anthropic.impl.streamChat({ apiKey: '' }, { model: 'claude-opus-5', messages: [] }, () => {}), /API key/);
});

function sse(res, events) {
  res.setHeader('Content-Type', 'text/event-stream');
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function claudeEvents(text, stopReason = 'end_turn', model = 'claude-opus-5') {
  return [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' }
  ];
}

test('anthropic streams text, sends system prompt and fallback beta for Opus 5', async () => {
  const requests = [];
  const s = await server(async (req, res) => {
    requests.push({ url: req.url, headers: req.headers, body: await readBody(req) });
    sse(res, claudeEvents('Hello from Claude'));
  });
  const cfg = { apiKey: 'test-key', baseUrl: s.url };
  const deltas = [];
  const r = await PROVIDERS.anthropic.impl.streamChat(cfg,
    { model: 'claude-opus-5', system: 'sys', messages: [{ role: 'user', content: 'hi' }] }, (d) => deltas.push(d));
  assert.strictEqual(r.text, 'Hello from Claude');
  assert.strictEqual(r.stopReason, 'end_turn');
  const first = requests[0];
  assert.strictEqual(first.headers['x-api-key'], 'test-key');
  assert.match(first.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.strictEqual(first.body.fallbacks, 'default');
  assert.strictEqual(first.body.system, 'sys');
  assert.strictEqual(first.body.max_tokens, 64000);

  await PROVIDERS.anthropic.impl.streamChat(cfg,
    { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }, () => {});
  assert.strictEqual(requests[1].body.fallbacks, undefined);
  assert.strictEqual(requests[1].headers['anthropic-beta'], undefined);
  s.close();
});

test('anthropic refusal is surfaced to the user', async () => {
  const s = await server(async (req, res) => {
    await readBody(req);
    sse(res, claudeEvents('', 'refusal'));
  });
  const r = await PROVIDERS.anthropic.impl.streamChat({ apiKey: 'k', baseUrl: s.url },
    { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'x' }] }, () => {});
  s.close();
  assert.strictEqual(r.stopReason, 'refusal');
  assert.match(r.text, /declined/);
});
