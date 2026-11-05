// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

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
  let body = '';
  try {
    body = await res.text();
  } catch {
    // ignore
  }
  return httpErrorFrom(res.status, body);
}

// The same, from a body already read.
function httpErrorFrom(status, body) {
  let detail = body || '';
  try {
    const j = JSON.parse(body);
    detail = (j.error && (j.error.message || j.error)) || j.message || body;
  } catch {
    // not JSON: the text itself
  }
  return new Error(`HTTP ${status}${detail ? `: ${String(detail).slice(0, 500)}` : ''}`);
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
// Hermes runs the agent on its own machine; Najwa AI shows what it does and
// passes the user's approval decisions back. Two ways to talk to it:
//
// - Runs (POST /v1/runs, then GET /v1/runs/{id}/events): the agent keeps
//   working if the connection drops (an iPhone cuts it as soon as you leave
//   the app), and the app reconnects and picks up where it left off: each
//   event has a number, and Hermes replays the ones after the last one seen.
// - Chat Completions (/v1/chat/completions), for Hermes versions without
//   runs. Its SSE stream has Hermes' own events too: `hermes.tool.progress`,
//   `approval.request` and `hermes.status`. A dropped connection loses the reply.

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

// The reply as it's written: reasoning in a <think> block, then the answer.
function replyWriter(onDelta) {
  const w = { text: '', thinking: false, answered: false, answerAt: 0, needGap: false };
  const out = (piece) => {
    w.text += piece;
    onDelta(piece);
  };
  w.reasoning = (piece) => {
    if (!piece || w.answered) return;
    if (!w.thinking) out('<think>');
    w.thinking = true;
    out(piece);
  };
  w.answer = (piece) => {
    if (!piece) return;
    if (w.thinking) out('</think>\n\n');
    w.thinking = false;
    if (w.needGap) out('\n\n');
    w.needGap = false;
    if (!w.answered) w.answerAt = w.text.length;
    w.answered = true;
    out(piece);
  };
  w.close = () => {
    if (w.thinking) out('</think>');
    w.thinking = false;
  };
  // Text written after this (e.g. after using a tool) starts a new paragraph.
  w.gap = () => {
    if (w.answered) w.needGap = true;
  };
  return w;
}

// How long to wait before each try at reconnecting to a run (then give up).
// Reset whenever the run is reached again. On a phone, waiting stops while
// the app is in the background, so these are counted while it's open.
const RUN_RECONNECT_MS = [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000];
const RUN_FINISHED = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

// Why Hermes ended a turn before the task was done (turn_exit_reason), in words.
function exitReason(reason) {
  if (typeof reason !== 'string' || !reason.trim()) return '';
  const steps = /^max_iterations_reached\((\d+)\/(\d+)\)/.exec(reason);
  if (steps) return `it used all of its ${steps[2]} steps for one reply. Send "continue" and it will carry on.`;
  if (/^max_iterations/.test(reason)) return 'it used all of its steps for one reply. Send "continue" and it will carry on.';
  return `it ended the turn early (${reason.trim().slice(0, 80)}).`;
}

const abortError = () => {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
};

const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(abortError());
  const done = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', stop);
  };
  const stop = () => {
    done();
    reject(abortError());
  };
  const timer = setTimeout(() => {
    done();
    resolve();
  }, ms);
  if (signal) signal.addEventListener('abort', stop);
});

// A dropped or refused connection (worth trying again), not an answer from Hermes.
const isNetworkError = (err) => err instanceof TypeError || (err && err.cause instanceof TypeError);

// `doFetch` is the phone's own network code in the mobile app (see
// src/native-fetch.js): Hermes only answers web pages from origins it lists,
// and the app's web view always sends one.
const hermesProvider = (doFetch = (...args) => fetch(...args)) => {
  // The approval a run is waiting on, as newer Hermes reports it: the turn's
  // generation and the question's id (the one asked for, or the only one), or
  // null when there's none to answer.
  async function currentApproval(cfg, runUrl, approvalId) {
    const res = await doFetch(runUrl, { headers: hermesHeaders(cfg) });
    if (!res.ok) return null;
    const run = await res.json();
    if (!run || !Number.isInteger(run.execution_generation)) return null;
    const asking = (Array.isArray(run.pending_controls) ? run.pending_controls : []).filter((p) => p && p.kind === 'approval' && p.prompt_id);
    const prompt = approvalId ? asking.find((p) => p.prompt_id === approvalId) : asking.length === 1 ? asking[0] : null;
    if (!prompt) return null;
    return { generation: Number.isInteger(prompt.execution_generation) ? prompt.execution_generation : run.execution_generation, id: prompt.prompt_id };
  }

  // Starts a run; null if this Hermes has no runs (an older version).
  async function startRun(cfg, req, signal) {
    const messages = textOnly(req.messages).map((m) => ({ role: m.role, content: String(m.content || '') }));
    const last = messages[messages.length - 1];
    const body = { model: req.model, input: last ? last.content : '', conversation_history: messages.slice(0, -1) };
    if (req.system) body.instructions = req.system;
    const res = await doFetch(`${trimSlash(cfg.baseUrl)}/runs`, {
      method: 'POST',
      // Sending it twice (after a dropped connection) starts it only once.
      headers: { ...hermesHeaders(cfg), 'Idempotency-Key': globalThis.crypto.randomUUID() },
      body: JSON.stringify(body),
      signal
    });
    if (res.status === 404 || res.status === 405) return null;
    if (!res.ok) throw await hermesError(res);
    const data = await res.json();
    if (!data.run_id) throw new Error('Hermes didn\'t start the run.');
    return data.run_id;
  }

  // Hands the running agent a message. False when it can't take one (the
  // run is ending, or this Hermes has no steering).
  async function steerRun(cfg, runId, text) {
    try {
      const res = await doFetch(`${trimSlash(cfg.baseUrl)}/runs/${encodeURIComponent(runId)}/steer`, {
        method: 'POST',
        headers: hermesHeaders(cfg),
        body: JSON.stringify({ input: text })
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => ({}));
      return data.accepted !== false;
    } catch {
      return false;
    }
  }

  // Follows a run's events until it finishes, reconnecting when the
  // connection drops. Resolves with { output, missed } (missed: some of the
  // reply may not have arrived) or throws.
  async function followRun(cfg, runId, w, signal, onInfo) {
    const base = `${trimSlash(cfg.baseUrl)}/runs/${encodeURIComponent(runId)}`;
    const headers = { ...hermesHeaders(cfg), Accept: 'text/event-stream' };
    delete headers['Content-Type'];
    let lastSeq = -1;
    let missed = false;
    let tries = 0;

    // The finished run, from its status (after its live events are gone).
    const fromStatus = async () => {
      const res = await doFetch(base, { headers, signal });
      if (res.status === 404) throw new Error('Hermes no longer has this run (was it restarted?). Ask again to get an answer.');
      if (!res.ok) throw await hermesError(res);
      const st = await res.json();
      if (!RUN_FINISHED.has(st.status)) return null;
      missed = true;
      return { event: `run.${st.status}`, ...st };
    };

    const handle = (evt) => {
      switch (evt.event) {
        case 'message.delta':
          w.answer(evt.delta);
          return null;
        case 'message.interim':
          // Text the agent wrote beside its tool calls, if it wasn't streamed already.
          if (!evt.already_streamed && evt.text) w.answer(`${evt.text}\n\n`);
          return null;
        case 'reasoning.available':
          if (evt.text) w.reasoning(w.thinking ? `\n\n${evt.text}` : evt.text);
          return null;
        case 'tool.started':
          onInfo({ kind: 'tool', id: evt.tool_call_id, tool: evt.tool, emoji: '', label: evt.preview || evt.tool, status: 'running' });
          return null;
        case 'tool.completed':
          onInfo({ kind: 'tool', id: evt.tool_call_id, tool: evt.tool, label: evt.tool, status: 'completed' });
          return null;
        case 'approval.request':
          onInfo({
            kind: 'approval',
            runId: evt.run_id || runId,
            approvalId: evt.request_id || null,
            // Newer Hermes answers only the exact turn that asked (see approve()).
            generation: Number.isInteger(evt.execution_generation) ? evt.execution_generation : null,
            command: evt.command || '',
            description: evt.description || '',
            choices: Array.isArray(evt.choices) && evt.choices.length ? evt.choices : ['once', 'deny']
          });
          return null;
        case 'run.queued':
          onInfo({ kind: 'status', text: String(evt.message || 'Waiting for Hermes to start…') });
          return null;
        case 'replay.truncated':
          // Too much happened while away to replay it all: the finished
          // answer comes with the run's end.
          missed = true;
          return null;
        default:
          return evt.event && evt.event.startsWith('run.') && RUN_FINISHED.has(evt.event.slice(4)) ? evt : null;
      }
    };

    const stop = () => {
      doFetch(`${base}/stop`, { method: 'POST', headers: hermesHeaders(cfg), body: '{}' }).catch(() => {});
    };
    if (signal && signal.aborted) {
      stop();
      throw abortError();
    }
    if (signal) signal.addEventListener('abort', stop);
    try {
      let end = null;
      while (!end) {
        if (signal && signal.aborted) throw abortError();
        try {
          const res = await doFetch(`${base}/events`, {
            headers: lastSeq >= 0 ? { ...headers, 'Last-Event-ID': String(lastSeq) } : headers,
            signal
          });
          if (res.status === 404) {
            end = await fromStatus();
            if (!end) throw new Error('Hermes stopped sending this run\'s progress.');
            break;
          }
          if (!res.ok) throw await hermesError(res);
          if (tries) onInfo({ kind: 'status', text: '' });
          tries = 0;
          for await (const { data } of readSse(res.body)) {
            let evt;
            try {
              evt = JSON.parse(data);
            } catch {
              continue;
            }
            if (Number.isInteger(evt.seq)) lastSeq = evt.seq;
            end = handle(evt);
            if (end) break;
          }
          // The stream ended without the run's end: it may have finished
          // meanwhile, otherwise reconnect.
          if (!end) end = await fromStatus();
          if (!end) await wait(RUN_RECONNECT_MS[0], signal);
        } catch (err) {
          if ((signal && signal.aborted) || !isNetworkError(err) || tries >= RUN_RECONNECT_MS.length) throw err;
          onInfo({ kind: 'status', text: 'Reconnecting to Hermes…' });
          await wait(RUN_RECONNECT_MS[tries++], signal);
        }
      }
      // pending_steer: what the user added that the agent never got to read.
      const pendingSteer = typeof end.pending_steer === 'string' ? end.pending_steer : '';
      // Newer Hermes ends a turn that stopped half way (its step budget ran out, a partial reply) as
      // run.failed with a turn_exit_reason; a run.completed that says it did not finish is the same.
      const unfinished = end.event === 'run.completed' && (end.completed === false || end.partial === true);
      if (end.event === 'run.completed' && !unfinished) return { output: typeof end.output === 'string' ? end.output : '', missed, pendingSteer };
      if (end.event === 'run.cancelled') {
        if (signal && signal.aborted) throw abortError();
        throw new Error('Hermes stopped this run before it finished.');
      }
      const why = exitReason(end.turn_exit_reason);
      if (why) throw new Error(`Hermes stopped before it finished: ${why}`);
      if (unfinished) throw new Error('Hermes stopped before it finished. Check the Hermes gateway\'s log for details.');
      throw new Error(end.error ? `Hermes couldn't finish: ${end.error}` : 'Hermes couldn\'t finish this run. Check the Hermes gateway\'s log for details.');
    } finally {
      if (signal) signal.removeEventListener('abort', stop);
    }
  }

  // Older Hermes: the whole run in one Chat Completions stream.
  async function chatCompletions(cfg, req, w, signal, onInfo) {
    const res = await doFetch(`${trimSlash(cfg.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: hermesHeaders(cfg),
      body: JSON.stringify({ model: req.model, messages: withSystem(req.system, textOnly(req.messages)), stream: true }),
      signal
    });
    if (!res.ok) throw await hermesError(res);
    let stopReason = 'end_turn';
    // The stream has to end the way Hermes ends it ([DONE], or a finish_reason):
    // a connection that just closes is a reply that stopped half way.
    let ended = false;
    for await (const { event, data } of readSse(res.body)) {
      if (data === '[DONE]') {
        ended = true;
        break;
      }
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
          // Newer Hermes answers only the exact turn that asked (see approve()).
          generation: Number.isInteger(evt.execution_generation) ? evt.execution_generation : null,
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
      w.reasoning(delta.reasoning_content);
      w.answer(delta.content);
      if (choice && choice.finish_reason) {
        ended = true;
        if (choice.finish_reason === 'length') stopReason = 'max_tokens';
        else if (choice.finish_reason !== 'stop') stopReason = choice.finish_reason;
      }
    }
    w.close();
    if (!ended && signal && signal.aborted) throw abortError();
    if (!ended) throw new Error('Hermes stopped sending the reply before it was finished (the connection closed). It may still be working on your computer: check Hermes, or send "continue".');
    if (stopReason !== 'end_turn' && stopReason !== 'max_tokens' && !w.answered) {
      throw new Error(`Hermes stopped before answering (${stopReason}). Check the Hermes gateway's log for details.`);
    }
    return stopReason;
  }

  return {
    async listModels(cfg) {
      const res = await doFetch(`${trimSlash(cfg.baseUrl)}/models`, { headers: hermesHeaders(cfg) });
      if (!res.ok) throw await hermesError(res);
      const data = await res.json();
      const ids = (data.data || []).map((m) => m.id);
      return ids.length ? ids.sort() : ['hermes-agent'];
    },

    // onInfo receives { kind: 'tool' | 'approval' | 'status' | 'replace', ... } as the agent works.
    async streamChat(cfg, req, onDelta, signal, onInfo = () => {}) {
      const w = replyWriter(onDelta);
      // A run that is already going (the app was closed while Hermes worked):
      // follow it again from the start, instead of asking again.
      const runId = req.resumeRun || await startRun(cfg, req, signal);
      // Kept with the reply, so the app can do that after it was closed.
      if (runId && !req.resumeRun) onInfo({ kind: 'run', runId });
      if (!runId) {
        const stopReason = await chatCompletions(cfg, req, w, signal, onInfo);
        return { text: w.text, stopReason };
      }
      // Messages the user sends while the agent works reach it after its
      // current step (POST /v1/runs/{id}/steer).
      if (req.steering) req.steering.send = (text) => steerRun(cfg, runId, text);
      let followed;
      try {
        followed = await followRun(cfg, runId, w, signal, onInfo);
      } finally {
        if (req.steering) req.steering.send = null;
      }
      const { output, missed, pendingSteer } = followed;
      const answer = w.answered ? w.text.slice(w.answerAt) : '';
      // Pictures come only with the finished answer: its MEDIA: files as
      // inline images (streamed text has just their paths on Hermes' computer).
      const pictures = /!\[[^\]]*\]\(data:image\//.test(output);
      if (output && (!w.answered || ((missed || pictures) && output !== answer))) {
        if (output.startsWith(answer) && !pictures) {
          w.answer(output.slice(answer.length));
        } else {
          // Part of the reply was missed while away, or it has pictures: use the finished answer.
          w.close();
          w.text = w.text.slice(0, w.answerAt) + output;
          onInfo({ kind: 'replace', text: w.text });
        }
      }
      w.close();
      return { text: w.text, stopReason: 'end_turn', ...(pendingSteer ? { pendingSteer } : {}) };
    },

    // choice: 'once' | 'session' | 'always' | 'deny'
    //
    // Newer Hermes (its session runtime) takes exactly { request_id,
    // execution_generation, choice }: the question and the turn that asked
    // it, which its approval.request carries. Older Hermes takes { choice,
    // request_id } and refuses the extra field. An approval asked before the
    // turn's generation was kept (or passed on without it) is answered with
    // the run's current generation, read from Hermes, on newer Hermes.
    async approve(cfg, { runId, choice, approvalId, generation }) {
      const base = trimSlash(cfg.baseUrl);
      const run = `${base}/runs/${encodeURIComponent(runId)}`;
      const send = (body) => doFetch(`${run}/approval`, { method: 'POST', headers: hermesHeaders(cfg), body: JSON.stringify(body) });
      const fenced = (gen, id) => ({ request_id: id, execution_generation: gen, choice });
      const exact = Number.isInteger(generation) && approvalId;
      let res = await send(exact ? fenced(generation, approvalId) : approvalId ? { choice, request_id: approvalId } : { choice });
      if (res.ok) return true;
      if (res.status === 401 || res.status === 403) throw await hermesError(res);
      const body = await res.text().catch(() => '');
      if (!exact && res.status === 400 && /invalid_params/.test(body)) {
        const now = await currentApproval(cfg, run, approvalId).catch(() => null);
        if (now) {
          res = await send(fenced(now.generation, now.id));
          if (res.ok) return true;
          throw await hermesError(res);
        }
      }
      throw httpErrorFrom(res.status, body);
    }
  };
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

  params(req) {
    const limit = anthropicMaxTokens.get(req.model) || DEFAULT_ANTHROPIC_MAX_TOKENS;
    const params = {
      model: req.model,
      max_tokens: Math.min(req.maxTokens > 0 ? req.maxTokens : DEFAULT_ANTHROPIC_MAX_TOKENS, limit),
      messages: anthropicMessages(req.messages)
    };
    if (req.system) params.system = req.system;
    if (SUMMARIZED_THINKING.test(req.model) && req.think !== false) params.thinking = { type: 'adaptive', display: 'summarized' };
    return params;
  },

  stream(client, params, signal) {
    if (FALLBACK_MODELS.has(params.model)) {
      // Re-run a declined request on Anthropic's recommended fallback model.
      return client.beta.messages.stream(
        { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
        { signal }
      );
    }
    return client.messages.stream(params, { signal });
  },

  async streamChat(cfg, req, onDelta, signal) {
    const client = this.client(cfg);
    const stream = this.stream(client, this.params(req), signal);

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
  hermes: { label: 'Hermes Agent', impl: hermesProvider() },
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

module.exports = {
  PROVIDERS, hermesProvider, normalizeMessages, ANTHROPIC_DEFAULT_MODELS, readLines, readSse,
  // For tool use (src/tool-chat.js).
  trimSlash, httpError, withSystem, textOnly, picturesOf, ollamaMessages, openaiMessages, anthropicMessages, capabilitiesOf, replyWriter
};
