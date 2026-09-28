// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Native on-device engine (Android): llama.cpp compiled for the phone, running
// on the CPU or, on Snapdragon phones, the Adreno GPU via OpenCL. Talks to
// LlamaPlugin.java. Same interface as the WebAssembly engine in on-device.js.

import { registerPlugin } from '@capacitor/core';
import { fitToContext } from './context.js';

const Llama = registerPlugin('Llama');

// Q4_0 files run fastest on Adreno GPUs (llama.cpp's OpenCL kernels are tuned
// for them) and also do well on the CPU. No 2 GB limit here, so bigger
// models are listed too.
export const CATALOG = [
  {
    name: 'Qwen 2.5 · 0.5B',
    note: 'Fastest · good for quick questions',
    size: 0.43e9,
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_0.gguf'
  },
  {
    name: 'Llama 3.2 · 1B',
    note: 'Fast all-rounder from Meta',
    size: 0.77e9,
    url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
  },
  {
    name: 'Gemma 3 · 1B',
    note: 'Google, friendly writing style',
    size: 0.72e9,
    url: 'https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q4_0.gguf'
  },
  {
    name: 'Qwen 2.5 · 1.5B',
    note: 'Smarter, multilingual (incl. Arabic)',
    size: 1.07e9,
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_0.gguf'
  },
  {
    name: 'Qwen 3 · 1.7B',
    note: 'Thinks before answering',
    size: 1.05e9,
    url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_0.gguf'
  },
  {
    name: 'Llama 3.2 · 3B',
    note: 'Noticeably smarter · needs 6 GB+ RAM',
    size: 1.92e9,
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_0.gguf'
  },
  {
    name: 'Qwen 2.5 · 3B',
    note: 'Strong multilingual (incl. Arabic) · 6 GB+ RAM',
    size: 2.0e9,
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_0.gguf'
  },
  {
    name: 'Gemma 3 · 4B',
    note: 'Best quality here · needs 8 GB+ RAM',
    size: 2.37e9,
    url: 'https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-Q4_0.gguf'
  },
  {
    name: 'Qwen 3 · 4B',
    note: 'Thinks before answering · 8 GB+ RAM',
    size: 2.38e9,
    url: 'https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_0.gguf'
  }
];

const DEFAULT_REPLY_TOKENS = 2048;

export function modelName(url) {
  return decodeURIComponent(String(url).split('?')[0].split('/').pop()).replace(/[^A-Za-z0-9._-]/g, '_');
}

// Returns { available, error, devices: [{type, name, description}] } and
// starts listening for engine events when the native engine is present.
let listening = false;
export async function probe() {
  let info;
  try {
    info = await Llama.info();
  } catch (err) {
    return { available: false, error: err.message || String(err), devices: [] };
  }
  if (info.available && !listening) {
    listening = true;
    Llama.addListener('download', onDownloadEvent);
    Llama.addListener('token', onTokenEvent);
    Llama.addListener('status', onStatusEvent);
  }
  return info;
}

// ---- downloads -------------------------------------------------------------

const downloads = new Map(); // url -> { loaded, total, error }
const progressListeners = new Set();
const namesByUrl = new Map();

function emitProgress() {
  for (const cb of progressListeners) cb(downloadState());
}

function onDownloadEvent(evt) {
  const d = downloads.get(evt.url) || {};
  if (evt.done) {
    if (evt.error && evt.error !== 'cancelled') downloads.set(evt.url, { ...d, error: evt.error });
    else downloads.delete(evt.url);
  } else {
    downloads.set(evt.url, { loaded: evt.loaded, total: evt.total });
  }
  emitProgress();
}

export function onDownloadProgress(cb) {
  progressListeners.add(cb);
  return () => progressListeners.delete(cb);
}

export function downloadState() {
  const out = {};
  for (const [url, d] of downloads) out[url] = { loaded: d.loaded || 0, total: d.total || 0, error: d.error || null };
  return out;
}

function urlsByName() {
  const byName = new Map();
  for (const c of CATALOG) byName.set(modelName(c.url), c.url);
  for (const [url, name] of namesByUrl) byName.set(name, url);
  return byName;
}

export async function listDownloaded() {
  const { models } = await Llama.listModels();
  const byName = urlsByName();
  return models.map((m) => ({ name: m.name, size: m.size, url: byName.get(m.name) || `local:${m.name}` }));
}

// Models Balimda downloaded that are gone from the phone although they were
// never deleted in Balimda (something else on the phone removed them).
export async function listMissing() {
  const { missing = [] } = await Llama.listModels();
  const byName = urlsByName();
  return missing.map((m) => ({ name: m.name, size: m.size || 0, at: m.at || 0, url: m.url || byName.get(m.name) || null }));
}

// Takes a missing model off the record without downloading it again.
export async function forgetMissing(name) {
  await Llama.deleteModel({ name });
}

export async function download(url) {
  if (!/^https?:\/\/.+\.gguf(\?.*)?$/i.test(url)) throw new Error('The link must point to a .gguf file');
  if (downloads.has(url) && !downloads.get(url).error) return;
  downloads.set(url, { loaded: 0, total: 0 });
  emitProgress();
  try {
    const { name } = await Llama.download({ url });
    namesByUrl.set(url, name);
  } catch (err) {
    downloads.set(url, { error: err.message || String(err) });
    emitProgress();
  }
}

export async function cancelDownload(url) {
  await Llama.cancelDownload({ url });
  downloads.delete(url);
  emitProgress();
}

export async function remove(url) {
  const name = url.startsWith('local:') ? url.slice(6) : modelName(url);
  await Llama.deleteModel({ name });
}

// ---- chat ------------------------------------------------------------------

const tokenListeners = new Map(); // requestId -> fn
const statusListeners = new Map(); // requestId -> fn
function onStatusEvent(evt) {
  const fn = statusListeners.get(evt.requestId);
  if (fn) fn(evt);
}
function onTokenEvent(evt) {
  const fn = tokenListeners.get(evt.requestId);
  if (fn) fn(evt.text);
}

let counter = 0;

export const nativeEngine = {
  async listModels() {
    return (await listDownloaded()).map((m) => m.name);
  },

  // onInfo({ device }) says where the reply runs as soon as the model is ready.
  async streamChat(cfg, req, onDelta, signal, onInfo) {
    const ctx = Number(cfg.contextSize) || 4096;
    const replyTokens = req.maxTokens > 0 ? req.maxTokens : Math.min(DEFAULT_REPLY_TOKENS, Math.floor(ctx / 2));
    // A rough first cut only: the engine counts the chat exactly and keeps as
    // much as fits in the context (see balimda_llama.cpp).
    const history = fitToContext(req.messages, req.system, ctx * 2, 0);
    const messages = req.system ? [{ role: 'system', content: req.system }, ...history] : history;

    const requestId = `r${Date.now()}-${counter++}`;
    let text = '';
    tokenListeners.set(requestId, (piece) => {
      text += piece;
      onDelta(piece);
    });
    statusListeners.set(requestId, (evt) => {
      if (evt.device && onInfo) onInfo({ device: evt.device });
    });
    const onAbort = () => Llama.stop({ requestId });
    if (signal) signal.addEventListener('abort', onAbort);
    try {
      const temperature = req.temperature != null && !Number.isNaN(req.temperature) ? req.temperature : 0.7;
      const { stopReason, stats } = await Llama.generate({
        requestId,
        model: req.model,
        messages,
        contextSize: ctx,
        gpu: cfg.nativeGpu !== false,
        maxTokens: replyTokens,
        temperature,
        background: !!req.background
      });
      if (stopReason === 'aborted') throw new DOMException('Aborted', 'AbortError');
      return { text, stopReason, stats: stats ? { engine: 'llama.cpp (native)', ...stats, messagesTotal: req.messages.length } : stats };
    } finally {
      tokenListeners.delete(requestId);
      statusListeners.delete(requestId);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
};

