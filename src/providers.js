// Model providers. Every provider exposes:
//   listModels(config)                          -> Promise<string[]>
//   streamChat(config, request, onDelta, signal) -> Promise<{ stopReason, text }>
// where request = { model, system, messages: [{role, content}], temperature, maxTokens }.

const Anthropic = require('@anthropic-ai/sdk');

const ANTHROPIC_DEFAULT_MODELS = ['claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5'];
// Models that support server-side refusal fallbacks ("default" routing).
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

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

// Read a fetch body line by line.
async function* readLines(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf) yield buf;
}

function withSystem(system, messages) {
  return system ? [{ role: 'system', content: system }, ...messages] : messages;
}

// ---- Ollama (local) ------------------------------------------------------

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
    const res = await fetch(`${trimSlash(cfg.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages: withSystem(req.system, req.messages),
        stream: true,
        options
      }),
      signal
    });
    if (!res.ok) throw await httpError(res);
    let text = '';
    let stopReason = 'end_turn';
    for await (const line of readLines(res.body)) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line);
      if (evt.error) throw new Error(evt.error);
      const piece = evt.message && evt.message.content;
      if (piece) {
        text += piece;
        onDelta(piece);
      }
      if (evt.done && evt.done_reason === 'length') stopReason = 'max_tokens';
    }
    return { text, stopReason };
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
        messages: withSystem(req.system, req.messages),
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
      for await (const line of readLines(res.body)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') break;
        const evt = JSON.parse(data);
        if (evt.error) throw new Error(evt.error.message || JSON.stringify(evt.error));
        const choice = evt.choices && evt.choices[0];
        const piece = choice && choice.delta && choice.delta.content;
        if (piece) {
          text += piece;
          onDelta(piece);
        }
        if (choice && choice.finish_reason === 'length') stopReason = 'max_tokens';
      }
      return { text, stopReason };
    }
  };
}

// ---- Anthropic (Claude) ----------------------------------------------------

const anthropic = {
  client(cfg) {
    if (!cfg.apiKey) throw new Error('Add your Anthropic API key in Settings → Providers.');
    return new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined });
  },

  async listModels(cfg) {
    if (!cfg.apiKey) return ANTHROPIC_DEFAULT_MODELS;
    const ids = [];
    for await (const m of this.client(cfg).models.list()) ids.push(m.id);
    return ids.length ? ids : ANTHROPIC_DEFAULT_MODELS;
  },

  async streamChat(cfg, req, onDelta, signal) {
    const client = this.client(cfg);
    const params = {
      model: req.model,
      max_tokens: req.maxTokens > 0 ? req.maxTokens : 64000,
      messages: req.messages
    };
    if (req.system) params.system = req.system;

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
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        onDelta(event.delta.text);
      }
    }
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
    if (!content) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n\n${content}`;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

module.exports = { PROVIDERS, normalizeMessages, ANTHROPIC_DEFAULT_MODELS, readLines };
