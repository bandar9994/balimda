// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

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

test('ollama shows a thinking model\'s reasoning, keeps it loaded and reports speed', async () => {
  const bodies = [];
  const s = await server(async (req, res) => {
    const body = await readBody(req);
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: body.model === 'qwen3.5:9b' ? ['completion', 'thinking'] : ['completion'] }));
    bodies.push(body);
    if (body.think !== false) {
      res.write(JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'Let me ' }, done: false }) + '\n');
      res.write(JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'think.' }, done: false }) + '\n');
    }
    res.write(JSON.stringify({ message: { content: 'Answer' }, done: false }) + '\n');
    res.end(JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', load_duration: 2.5e9,
      prompt_eval_count: 30, prompt_eval_duration: 0.5e9, eval_count: 40, eval_duration: 2e9 }) + '\n');
  });
  const ask = (cfg, model) => PROVIDERS.ollama.impl.streamChat({ baseUrl: s.url, ...cfg }, { model, messages: [{ role: 'user', content: 'hi' }] }, () => {});

  const r = await ask({}, 'qwen3.5:9b');
  assert.strictEqual(r.text, '<think>Let me think.</think>\n\nAnswer');
  assert.strictEqual(bodies[0].keep_alive, '30m');
  assert.ok(!('think' in bodies[0]), 'thinking left on by default');
  assert.deepStrictEqual(r.stats, { engine: 'Ollama', device: 'Ollama', loadMs: 2500, promptTokens: 30, promptMs: 500, tokens: 40, ms: 2000 });

  // Thinking switched off: sent only to models that can think.
  const fast = await ask({ think: false }, 'qwen3.5:9b');
  assert.strictEqual(fast.text, 'Answer');
  assert.strictEqual(bodies[1].think, false);
  await ask({ think: false }, 'llama3.2');
  assert.ok(!('think' in bodies[2]), 'never sent to models without thinking');
  s.close();
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

test('anthropic shows the thinking summary and keeps within each model\'s output limit', async () => {
  const requests = [];
  const s = await server(async (req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        data: [
          { type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-01-01T00:00:00Z', max_tokens: 128000 },
          { type: 'model', id: 'claude-3-haiku-20240307', display_name: 'Claude Haiku 3', created_at: '2024-03-07T00:00:00Z', max_tokens: 4096 }
        ],
        has_more: false,
        first_id: 'claude-opus-5',
        last_id: 'claude-3-haiku-20240307'
      }));
    }
    requests.push(await readBody(req));
    const events = claudeEvents('The answer.');
    events.splice(1, 0,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weighing it up.' } },
      { type: 'content_block_stop', index: 0 });
    sse(res, events);
  });
  const cfg = { apiKey: 'k', baseUrl: s.url };
  try {
    assert.deepStrictEqual(await PROVIDERS.anthropic.impl.listModels(cfg), ['claude-opus-5', 'claude-3-haiku-20240307']);

    const r = await PROVIDERS.anthropic.impl.streamChat(cfg, { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }, () => {});
    assert.strictEqual(r.text, '<think>Weighing it up.</think>\n\nThe answer.');
    assert.deepStrictEqual(requests[0].thinking, { type: 'adaptive', display: 'summarized' });
    assert.strictEqual(requests[0].max_tokens, 64000);

    await PROVIDERS.anthropic.impl.streamChat(cfg, { model: 'claude-3-haiku-20240307', messages: [{ role: 'user', content: 'hi' }] }, () => {});
    assert.strictEqual(requests[1].max_tokens, 4096);
    assert.strictEqual(requests[1].thinking, undefined);

    // Quick background jobs (titles, memory) don't ask for the summary.
    await PROVIDERS.anthropic.impl.streamChat(cfg, { model: 'claude-opus-5', think: false, messages: [{ role: 'user', content: 'hi' }] }, () => {});
    assert.strictEqual(requests[2].thinking, undefined);
  } finally {
    s.close();
  }
});

test('openai-compatible shows a thinking model\'s reasoning', async () => {
  const s = await server(async (req, res) => {
    await readBody(req);
    res.setHeader('Content-Type', 'text/event-stream');
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: 'assistant' }));
    res.write(chunk({ reasoning_content: 'Hmm, ' }));
    res.write(chunk({ reasoning_content: 'easy.' }));
    res.write(chunk({ content: '4' }));
    res.write(chunk({}, 'stop'));
    res.end('data: [DONE]\n\n');
  });
  const r = await PROVIDERS.openaiCompatible.impl.streamChat({ baseUrl: s.url }, { model: 'qwen3', messages: [{ role: 'user', content: '2+2' }] }, () => {});
  s.close();
  assert.strictEqual(r.text, '<think>Hmm, easy.</think>\n\n4');
});
