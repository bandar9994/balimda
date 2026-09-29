// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Model providers. Every provider exposes:
//   listModels(config)                          -> Promise<string[]>
//   streamChat(config, request, onDelta, signal) -> Promise<{ stopReason, text }>
// where request = { model, system, messages: [{role, content, images?}], temperature, maxTokens }.
// A user message's pictures are data URLs ("data:image/jpeg;base64,..."); each
// provider sends them the way its API takes them.

const Anthropic = require('@anthropic-ai/sdk');

const ANTHROPIC_DEFAULT_MODELS = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
// Models that support server-side refusal fallbacks ("default" routing).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

async function httpError(res) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      detail = (j.error && (j.error.message || j.error)) || j.message || body;
    } catch {
      detail = body;
    }
  } catch {
    // ignore
  }
  return new Error(`HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 500)}` : ''}`);
}

// Read a fetch body line by line. Uses getReader() so it works in Node,
// Chromium and Safari/WebKit alike.
async function* readLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        yield buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
      }
    }
    buf += decoder.decode();
    if (buf) yield buf;
  } finally {
    reader.releaseLock();
  }
}

function withSystem(system, messages) {
  return system ? [{ role: 'system', content: system }, ...messages] : messages;
}

// "data:image/jpeg;base64,AAA" -> { mediaType: 'image/jpeg', data: 'AAA' }
function splitDataUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ''));
  return m ? { mediaType: m[1], data: m[2] } : null;
}
const picturesOf = (m) => (Array.isArray(m.images) ? m.images : []).map(splitDataUrl).filter(Boolean);

// Text only, for servers that don't take pictures.
const textOnly = (messages) => messages.map(({ role, content }) => ({ role, content }));

// Ollama: base64 pictures in the message's "images".
const ollamaMessages = (messages) => messages.map((m) => {
  const pics = picturesOf(m);
  return pics.length ? { role: m.role, content: m.content, images: pics.map((p) => p.data) } : { role: m.role, content: m.content };
});

// OpenAI-style APIs: a message with pictures has a list of parts.
const openaiMessages = (messages) => messages.map((m) => {
  const pics = picturesOf(m);
  if (!pics.length) return { role: m.role, content: m.content };
  const parts = pics.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } }));
  if (m.content) parts.push({ type: 'text', text: m.content });
  return { role: m.role, content: parts };
});

// Claude: image blocks before the text.
const anthropicMessages = (messages) => messages.map((m) => {
  const pics = picturesOf(m);
  if (!pics.length) return { role: m.role, content: m.content };
  const blocks = pics.map((p) => ({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }));
  if (m.content) blocks.push({ type: 'text', text: m.content });
  return { role: m.role, content: blocks };
});

// ---- Ollama (local) ------------------------------------------------------

// What a model can do, from Ollama (asked once per model): whether it can
// think before answering (Qwen 3/3.5, DeepSeek-R1…; Ollama rejects `think`
// for models that can't) and whether it can see pictures. null if unknown.
const modelCapabilities = new Map();
async function capabilitiesOf(cfg, model) {
  const key = `${trimSlash(cfg.baseUrl)}|${model}`;
  if (!modelCapabilities.has(key)) {
    let caps = null;
    try {
      const res = await fetch(`${trimSlash(cfg.baseUrl)}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model })
      });
      if (res.ok) caps = (await res.json()).capabilities || [];
    } catch {
      // unknown
    }
    modelCapabilities.set(key, caps);
  }
  return modelCapabilities.get(key);
}
const supportsThinking = async (cfg, model) => ((await capabilitiesOf(cfg, model)) || []).includes('thinking');

const ns = (v) => (Number(v) || 0) / 1e6;

const ollama = {
  async listModels(cfg) {
    const res = await fetch(`${trimSlash(cfg.baseUrl)}/api/tags`);
    if (!res.ok) throw await httpError(res);
    const data = await res.json();
    return (data.models || []).map((m) => m.name).sort();
  },

  async streamChat(cfg, req, onDelta, signal) {
    const options = {};
    if (req.temperature != null) options.temperature = req.temperature;
    if (req.maxTokens > 0) options.num_predict = req.maxTokens;
    let messages = req.messages;
    if (messages.some((m) => picturesOf(m).length)) {
      const caps = await capabilitiesOf(cfg, req.model);
      if (caps && !caps.includes('vision')) {
        // Pictures in the message being answered need a model that can see;
        // earlier ones (e.g. sent to another model) are left out.
        if (picturesOf(messages[messages.length - 1] || {}).length) {
          throw new Error(`${req.model} can't see pictures. Pick a model that can (in Ollama, a vision model such as gemma3 or qwen2.5vl).`);
        }
        messages = textOnly(messages);
      }
    }
    const body = {
      model: req.model,
      messages: withSystem(req.system, ollamaMessages(messages)),
      stream: true,
      // Keep the model in memory between messages; Ollama's default of
      // 5 minutes means reloading it (slow for big models) after a pause.
      keep_alive: '30m',
      options
    };
    // Thinking can be switched off in settings, or per request (quick
    // background jobs like titles and memory don't need it).
    if ((cfg.think === false || req.think === false) && await supportsThinking(cfg, req.model)) body.think = false;
    const res = await fetch(`${trimSlash(cfg.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) throw await httpError(res);
    let text = '';
    let stopReason = 'end_turn';
    let stats;
    let thinking = false;
    const out = (piece) => {
      text += piece;
      onDelta(piece);
    };
    for await (const line of readLines(res.body)) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line);
      if (evt.error) throw new Error(evt.error);
      // Thinking models send their reasoning separately; show it the same way
      // as other engines, in a <think> block, so the wait isn't silent.
      const thought = evt.message && evt.message.thinking;
      if (thought) {
        if (!thinking) out('<think>');
        thinking = true;
        out(thought);
      }
      const piece = evt.message && evt.message.content;
      if (piece) {
        if (thinking) out('</think>\n\n');
        thinking = false;
        out(piece);
      }
      if (evt.done) {
        if (evt.done_reason === 'length') stopReason = 'max_tokens';
        if (evt.eval_count) {
          stats = {
            engine: 'Ollama',
            device: 'Ollama',
            loadMs: ns(evt.load_duration),
            promptTokens: evt.prompt_eval_count || 0,
            promptMs: ns(evt.prompt_eval_duration),
            tokens: evt.eval_count,
            ms: ns(evt.eval_duration)
          };
        }
      }
    }
    if (thinking) out('</think>');
    return { text, stopReason, stats };
  }
};

// ---- OpenAI and OpenAI-compatible servers (LM Studio, llama.cpp, vLLM…) ----

function openaiLike({ sendSampling }) {
  const headers = (cfg) => {
    const h = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
    return h;
  };
  return {
    async listModels(cfg) {
      const res = await fetch(`${trimSlash(cfg.baseUrl)}/models`, { headers: headers(cfg) });
      if (!res.ok) throw await httpError(res);
      const data = await res.json();
      return (data.data || []).map((m) => m.id).sort();
    },

    async streamChat(cfg, req, onDelta, signal) {
      const body = {
        model: req.model,
        messages: withSystem(req.system, openaiMessages(req.messages)),
        stream: true
      };
      if (sendSampling) {
        if (req.temperature != null) body.temperature = req.temperature;
        if (req.maxTokens > 0) body.max_tokens = req.maxTokens;
      } else if (req.maxTokens > 0) {
        body.max_completion_tokens = req.maxTokens;
      }
      const res = await fetch(`${trimSlash(cfg.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: headers(cfg),
        body: JSON.stringify(body),
        signal
      });
      if (!res.ok) throw await httpError(res);
      let text = '';
      let stopReason = 'end_turn';
      let thinking = false;
      let answered = false;
      const out = (piece) => {
        text += piece;
        onDelta(piece);
      };
      for await (const line of readLines(res.body)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') break;
        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          continue; // an empty keep-alive or a line that isn't JSON
        }
        if (evt.error) throw new Error(evt.error.message || JSON.stringify(evt.error));
        const choice = evt.choices && evt.choices[0];
        const delta = (choice && choice.delta) || {};
        // Thinking models on LM Studio, llama.cpp, vLLM… stream their reasoning
        // separately; show it in a <think> block like other engines.
        const thought = delta.reasoning_content || delta.reasoning;
        if (thought && typeof thought === 'string' && !answered) {
          if (!thinking) out('<think>');
          thinking = true;
          out(thought);
        }
        if (delta.content) {
          if (thinking) out('</think>\n\n');
          thinking = false;
          answered = true;
          out(delta.content);
        }
        if (choice && choice.finish_reason === 'length') stopReason = 'max_tokens';
      }
      if (thinking) out('</think>');
      return { text, stopReason };
    }
  };
}

// ---- Hermes Agent (Nous Research) ---------------------------------------------
// Hermes' API server speaks OpenAI Chat Completions, plus its own SSE events:
// `hermes.tool.progress` (a tool started or finished), `approval.request`
// (it wants permission to run something risky) and `hermes.status`. The
// agent runs tools on its own machine; Balimda shows what it does and passes
// the user's approval decisions back.

// Server-sent events as { event, data } (comment lines like ": keepalive" skipped).
async function* readSse(body) {
  let event = null;
  let data = [];
  for await (const line of readLines(body)) {
    if (line === '') {
      if (data.length) yield { event: event || 'message', data: data.join('\n') };
      event = null;
      data = [];
    } else if (line.startsWith(':')) {
      continue;
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length) yield { event: event || 'message', data: data.join('\n') };
}

const hermesHeaders = (cfg) => {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  return h;
};

async function hermesError(res) {
  if (res.status === 401 || res.status === 403) return new Error('Hermes didn\'t accept the API key. Use the API_SERVER_KEY from ~/.hermes/.env.');
  return httpError(res);
}

const hermes = {
  async listModels(cfg) {
    const res = await fetch(`${trimSlash(cfg.baseUrl)}/models`, { headers: hermesHeaders(cfg) });
    if (!res.ok) throw await hermesError(res);
    const data = await res.json();
    const ids = (data.data || []).map((m) => m.id);
    return ids.length ? ids.sort() : ['hermes-agent'];
  },

  // onInfo receives { kind: 'tool' | 'approval' | 'status', ... } as the agent works.
  async streamChat(cfg, req, onDelta, signal, onInfo = () => {}) {
    const res = await fetch(`${trimSlash(cfg.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: hermesHeaders(cfg),
      body: JSON.stringify({ model: req.model, messages: withSystem(req.system, textOnly(req.messages)), stream: true }),
      signal
    });
    if (!res.ok) throw await hermesError(res);
    let text = '';
    let thinking = false;
    let answered = false;
    let stopReason = 'end_turn';
    const out = (piece) => {
      text += piece;
      onDelta(piece);
    };
    for await (const { event, data } of readSse(res.body)) {
      if (data === '[DONE]') break;
      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (event === 'hermes.tool.progress') {
        onInfo({ kind: 'tool', id: evt.toolCallId, tool: evt.tool, emoji: evt.emoji || '', label: evt.label || evt.tool, status: evt.status });
        continue;
      }
      if (event === 'approval.request') {
        onInfo({
          kind: 'approval',
          runId: evt.run_id,
          approvalId: evt.request_id || null,
          command: evt.command || '',
          description: evt.description || '',
          choices: Array.isArray(evt.choices) && evt.choices.length ? evt.choices : ['once', 'deny']
        });
        continue;
      }
      if (event === 'hermes.status') {
        if (evt.text) onInfo({ kind: 'status', text: String(evt.text) });
        continue;
      }
      if (event !== 'message') continue;
      if (evt.error) throw new Error(evt.error.message || JSON.stringify(evt.error));
      const choice = evt.choices && evt.choices[0];
      const delta = (choice && choice.delta) || {};
      // Reasoning goes in a <think> block, like other thinking models.
      if (delta.reasoning_content && !answered) {
        if (!thinking) out('<think>');
        thinking = true;
        out(delta.reasoning_content);
      }
      if (delta.content) {
        if (thinking) out('</think>\n\n');
        thinking = false;
        answered = true;
        out(delta.content);
      }
      if (choice && choice.finish_reason) {
        if (choice.finish_reason === 'length') stopReason = 'max_tokens';
        else if (choice.finish_reason !== 'stop') stopReason = choice.finish_reason;
      }
    }
    if (thinking) out('</think>');
    if (stopReason !== 'end_turn' && stopReason !== 'max_tokens' && !answered) {
      throw new Error(`Hermes stopped before answering (${stopReason}). Check the Hermes gateway's log for details.`);
    }
    return { text, stopReason };
  },

  // choice: 'once' | 'session' | 'always' | 'deny'
  async approve(cfg, { runId, choice, approvalId }) {
    const res = await fetch(`${trimSlash(cfg.baseUrl)}/runs/${encodeURIComponent(runId)}/approval`, {
      method: 'POST',
      headers: hermesHeaders(cfg),
      body: JSON.stringify(approvalId ? { choice, request_id: approvalId } : { choice })
    });
    if (!res.ok) throw await hermesError(res);
    return true;
  }
};

// ---- Anthropic (Claude) ----------------------------------------------------

// Output limit per model, from the Models API (older models allow far fewer
// than the 64K asked for by default, and reject the request otherwise).
const anthropicMaxTokens = new Map();
const DEFAULT_ANTHROPIC_MAX_TOKENS = 64000;

// Models that think by default with the thinking text hidden: ask for a
// readable summary, so the wait before the answer isn't silent.
const SUMMARIZED_THINKING = /^claude-(opus-5|fable-5|mythos-5|sonnet-5)/;

const anthropic = {
  client(cfg) {
    if (!cfg.apiKey) throw new Error('Add your Anthropic API key in Settings → Providers.');
    // The mobile app calls the API straight from the app's web view.
    return new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined, dangerouslyAllowBrowser: true });
  },

  async listModels(cfg) {
    if (!cfg.apiKey) return ANTHROPIC_DEFAULT_MODELS;
    const ids = [];
    for await (const m of this.client(cfg).models.list()) {
      ids.push(m.id);
      if (m.max_tokens > 0) anthropicMaxTokens.set(m.id, m.max_tokens);
    }
    return ids.length ? ids : ANTHROPIC_DEFAULT_MODELS;
  },

  async streamChat(cfg, req, onDelta, signal) {
    const client = this.client(cfg);
    const limit = anthropicMaxTokens.get(req.model) || DEFAULT_ANTHROPIC_MAX_TOKENS;
    const params = {
      model: req.model,
      max_tokens: Math.min(req.maxTokens > 0 ? req.maxTokens : DEFAULT_ANTHROPIC_MAX_TOKENS, limit),
      messages: anthropicMessages(req.messages)
    };
    if (req.system) params.system = req.system;
    if (SUMMARIZED_THINKING.test(req.model) && req.think !== false) params.thinking = { type: 'adaptive', display: 'summarized' };

    let stream;
    if (FALLBACK_MODELS.has(req.model)) {
      // Re-run a declined request on Anthropic's recommended fallback model.
      stream = client.beta.messages.stream(
        { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
        { signal }
      );
    } else {
      stream = client.messages.stream(params, { signal });
    }

    let text = '';
    let thinking = false;
    let answered = false;
    const out = (piece) => {
      text += piece;
      onDelta(piece);
    };
    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      // The thinking summary goes in a <think> block, like other thinking models.
      if (event.delta.type === 'thinking_delta' && event.delta.thinking && !answered) {
        if (!thinking) out('<think>');
        thinking = true;
        out(event.delta.thinking);
      } else if (event.delta.type === 'text_delta') {
        if (thinking) out('</think>\n\n');
        thinking = false;
        answered = true;
        out(event.delta.text);
      }
    }
    if (thinking) out('</think>');
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      const why = final.stop_details && final.stop_details.explanation;
      const note = `\n\n_The model declined this request${why ? `: ${why}` : '.'}_`;
      text += note;
      onDelta(note);
    }
    return { text, stopReason: final.stop_reason };
  }
};

const PROVIDERS = {
  ollama: { label: 'Ollama (local)', impl: ollama },
  openaiCompatible: { label: 'LM Studio / OpenAI-compatible (local)', impl: openaiLike({ sendSampling: true }) },
  hermes: { label: 'Hermes Agent', impl: hermes },
  anthropic: { label: 'Anthropic Claude', impl: anthropic },
  openai: { label: 'OpenAI', impl: openaiLike({ sendSampling: false }) }
};

// Anthropic requires strictly alternating user/assistant turns that start with
// a user turn; merge neighbours and drop empties so every provider is happy.
function normalizeMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const content = String(m.content || '').trim();
    // Pictures only come from the user.
    const images = m.role === 'user' && Array.isArray(m.images) ? m.images.filter((u) => typeof u === 'string' && u.startsWith('data:image/')) : [];
    if (!content && !images.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = [prev.content, content].filter(Boolean).join('\n\n');
      if (images.length) prev.images = [...(prev.images || []), ...images];
    } else {
      out.push(images.length ? { role: m.role, content, images } : { role: m.role, content });
    }
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

module.exports = { PROVIDERS, normalizeMessages, ANTHROPIC_DEFAULT_MODELS, readLines, readSse };
