// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// On-device models: llama.cpp compiled to WebAssembly (wllama), so chats work
// offline and never leave the phone. Models are GGUF files downloaded once
// and kept in the app's private storage.

import { Wllama, LoggerWithoutDebug } from '@wllama/wllama';

// Small instruction-tuned models that fit comfortably on a phone.
// (Single files must stay under 2 GB for WebAssembly.)
export const CATALOG = [
  {
    name: 'Qwen 2.5 · 0.5B',
    note: 'Fastest · good for quick questions',
    size: 0.49e9,
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf'
  },
  {
    name: 'Llama 3.2 · 1B',
    note: 'Fast all-rounder from Meta',
    size: 0.81e9,
    url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf'
  },
  {
    name: 'Gemma 3 · 1B',
    note: 'Google, friendly writing style',
    size: 0.81e9,
    url: 'https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q4_K_M.gguf'
  },
  {
    name: 'Qwen 2.5 · 1.5B',
    note: 'Smarter, multilingual (incl. Arabic)',
    size: 1.12e9,
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf'
  },
  {
    name: 'Qwen 3 · 1.7B',
    note: 'Thinks before answering · slower',
    size: 1.11e9,
    url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf'
  },
  {
    name: 'SmolLM2 · 1.7B',
    note: 'Hugging Face, English',
    size: 1.06e9,
    url: 'https://huggingface.co/bartowski/SmolLM2-1.7B-Instruct-GGUF/resolve/main/SmolLM2-1.7B-Instruct-Q4_K_M.gguf'
  }
];

const WASM_PATHS = { default: new URL('wllama/wllama.wasm', document.baseURI).href };
const DEFAULT_REPLY_TOKENS = 1024;

export function modelName(url) {
  return decodeURIComponent(String(url).split('?')[0].split('/').pop());
}

let manager = null;   // Wllama used only for its model cache
let engine = null;    // Wllama with a model loaded
let loaded = null;    // { url, ctx, gpu }
let queue = Promise.resolve();
const downloads = new Map(); // url -> { loaded, total, controller, error }
const listeners = new Set();

function newWllama() {
  return new Wllama(WASM_PATHS, { logger: LoggerWithoutDebug, parallelDownloads: 3 });
}

function models() {
  if (!manager) manager = newWllama();
  return manager.modelManager;
}

function emit() {
  for (const cb of listeners) cb(downloadState());
}

// One inference at a time: the engine holds a single model in memory.
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export function onDownloadProgress(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function downloadState() {
  const out = {};
  for (const [url, d] of downloads) out[url] = { loaded: d.loaded, total: d.total, error: d.error || null };
  return out;
}

export async function listDownloaded() {
  const list = await models().getModels();
  return list.map((m) => ({ url: m.url, name: modelName(m.url), size: m.size }));
}

export async function download(url) {
  if (!/^https?:\/\/.+\.gguf(\?.*)?$/i.test(url)) throw new Error('The link must point to a .gguf file');
  if (downloads.has(url) && !downloads.get(url).error) return;
  const controller = new AbortController();
  const state = { loaded: 0, total: 0, controller };
  downloads.set(url, state);
  emit();
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await models().downloadModel(url, {
      signal: controller.signal,
      progressCallback: ({ loaded: done, total }) => {
        state.loaded = done;
        state.total = total;
        emit();
      }
    });
    downloads.delete(url);
  } catch (err) {
    if (controller.signal.aborted) downloads.delete(url);
    else state.error = err.message || String(err);
  }
  emit();
}

export function cancelDownload(url) {
  const d = downloads.get(url);
  if (!d) return;
  if (d.controller) d.controller.abort();
  downloads.delete(url);
  emit();
}

export async function remove(url) {
  return serial(async () => {
    if (loaded && loaded.url === url) await unload();
    const list = await models().getModels();
    const model = list.find((m) => m.url === url);
    if (model) await model.remove();
  });
}

async function unload() {
  if (engine) {
    try {
      await engine.exit();
    } catch {
      // already gone
    }
  }
  engine = null;
  loaded = null;
}

async function ensureLoaded(name, ctx, gpu) {
  const list = await models().getModels();
  const model = list.find((m) => modelName(m.url) === name);
  if (!model) throw new Error(`"${name}" isn't downloaded on this phone. Download it in Settings → Models.`);
  if (loaded && loaded.url === model.url && loaded.ctx === ctx && loaded.gpu === gpu) return engine;
  await unload();
  engine = newWllama();
  // Stream raw text: the UI already understands <think> blocks, and skipping
  // llama.cpp's template-specific output parser avoids failures on models
  // whose chat format it doesn't recognise.
  const params = { n_ctx: ctx, n_parallel: 1, skip_chat_parsing: true };
  // Run on the CPU unless the user opts in: many phone GPUs lack the
  // precision llama.cpp's WebGPU kernels need and produce garbled text.
  if (!gpu) params.n_gpu_layers = 0;
  await engine.loadModel(model, params);
  loaded = { url: model.url, ctx, gpu };
  return engine;
}

// Keep the newest messages that fit the context window (rough estimate:
// ~3 characters per token), always leaving room for the reply.
export function fitToContext(messages, system, ctx, replyTokens) {
  const budget = Math.max(256, ctx - replyTokens - 64) * 3;
  let used = (system || '').length;
  const kept = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    used += messages[i].content.length + 16;
    if (used > budget && kept.length) break;
    kept.unshift(messages[i]);
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

export const onDevice = {
  async listModels() {
    return (await listDownloaded()).map((m) => m.name);
  },

  streamChat(cfg, req, onDelta, signal) {
    return serial(async () => {
      const ctx = Number(cfg.contextSize) || 4096;
      const replyTokens = req.maxTokens > 0 ? req.maxTokens : Math.min(DEFAULT_REPLY_TOKENS, Math.floor(ctx / 2));
      const w = await ensureLoaded(req.model, ctx, !!cfg.useGpu);
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const history = fitToContext(req.messages, req.system, ctx, replyTokens);
      const messages = req.system ? [{ role: 'system', content: req.system }, ...history] : history;
      const params = { messages, stream: true, max_tokens: replyTokens, abortSignal: signal };
      if (req.temperature != null && !Number.isNaN(req.temperature)) params.temperature = req.temperature;

      let text = '';
      let thinking = false;
      let stopReason = 'end_turn';
      let pieces = 0;
      let firstAt = 0;
      const out = (piece) => {
        if (!firstAt) firstAt = performance.now();
        pieces++;
        text += piece;
        onDelta(piece);
      };
      const started = performance.now();
      const stream = await w.createChatCompletion(params);
      for await (const chunk of stream) {
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        // Reasoning models (Qwen 3, DeepSeek-R1) stream their thoughts separately.
        if (delta.reasoning_content) {
          if (!thinking) out('<think>');
          thinking = true;
          out(delta.reasoning_content);
        }
        if (delta.content) {
          if (thinking) out('</think>\n\n');
          thinking = false;
          out(delta.content);
        }
        if (choice.finish_reason === 'length') stopReason = 'max_tokens';
      }
      if (thinking) out('</think>');
      // Streamed pieces are about one token each.
      const stats = {
        engine: 'WebAssembly',
        device: cfg.useGpu ? 'GPU (WebGPU)' : 'CPU',
        offload: '',
        promptTokens: 0,
        promptMs: firstAt ? firstAt - started : 0,
        tokens: pieces,
        ms: firstAt ? performance.now() - firstAt : 0
      };
      return { text, stopReason, stats };
    });
  }
};
