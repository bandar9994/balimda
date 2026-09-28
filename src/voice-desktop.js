// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Voice chat in the desktop app: speech recognition with Whisper, on this
// computer. whisper.cpp's server (built by scripts/build-whisper.js and
// shipped with the app) is started with the chosen model when the user
// first talks, and stopped after a while without use. The model is
// downloaded once, from Settings → Voice.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const WHISPER_MODELS = [
  {
    id: 'turbo',
    name: 'Whisper large-v3 turbo',
    note: 'The most accurate, also for Arabic and for Arabic mixed with English',
    size: 574e6,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'
  },
  {
    id: 'small',
    name: 'Whisper small',
    note: 'Faster on older computers, but makes more mistakes',
    size: 190e6,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
    // Accurate with a window sized to the recording (the large model isn't).
    sizedWindow: true
  }
];

const IDLE_STOP_MS = 10 * 60 * 1000;
const DOWNLOAD_RETRIES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What Whisper sometimes "hears" in silence or noise, not what was said.
const NOT_SPEECH = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+)\s*$/;
const PHANTOMS = /^(thank you\.?|thanks for watching[.!]?|you|ترجمة نانسي قنقر|اشتركوا في القناة|شكرا للمشاهدة)$/i;

function cleanTranscript(text) {
  const t = String(text || '')
    .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || NOT_SPEECH.test(t) || PHANTOMS.test(t)) return '';
  return t;
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/**
 * @param {object} o
 * @param {string} o.binDir     folder with whisper-server(.exe) and its libraries
 * @param {string} o.modelsDir  where models are downloaded
 * @param {function} o.onEvent  receives {download: {id, loaded, total, done, error}}
 * @param {function} [o.fetch]  fetch for downloads (the app passes Electron's, which uses the system proxy)
 */
function createVoice({ binDir, modelsDir, onEvent = () => {}, fetch: fetchImpl = fetch }) {
  const exe = path.join(binDir, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server');
  const fileOf = (m) => path.join(modelsDir, path.basename(new URL(m.url).pathname));
  const byId = (id) => WHISPER_MODELS.find((m) => m.id === id) || WHISPER_MODELS[0];
  const downloads = new Map(); // model id -> { loaded, total, controller }
  let server = null;           // { proc, port, modelId, dead, ready }
  let idleTimer = null;

  // The large model is quick enough with a Mac's GPU or a CPU with many cores
  // (on 4 threads it takes about 20 s for 11 s of speech; the small one 2 s).
  const recommended = (process.platform === 'darwin' && process.arch === 'arm64') || os.cpus().length >= 16 ? 'turbo' : 'small';

  function status() {
    return {
      available: fs.existsSync(exe),
      recommended,
      models: WHISPER_MODELS.map((m) => {
        const d = downloads.get(m.id);
        return {
          id: m.id, name: m.name, note: m.note, size: m.size,
          downloaded: fs.existsSync(fileOf(m)),
          download: d ? { loaded: d.loaded, total: d.total } : null
        };
      })
    };
  }

  // Downloads a model; when the connection drops, carries on where it stopped.
  async function download(id) {
    const m = byId(id);
    if (downloads.has(m.id) || fs.existsSync(fileOf(m))) return;
    fs.mkdirSync(modelsDir, { recursive: true });
    const part = `${fileOf(m)}.part`;
    const d = { loaded: 0, total: m.size, controller: new AbortController() };
    downloads.set(m.id, d);
    const emit = (extra = {}) => onEvent({ download: { id: m.id, loaded: d.loaded, total: d.total, ...extra } });
    let failures = 0;
    let lastEmit = 0;
    try {
      for (;;) {
        try {
          const headers = d.loaded > 0 ? { Range: `bytes=${d.loaded}-` } : {};
          const res = await fetchImpl(m.url, { headers, signal: d.controller.signal });
          if (!res.ok) throw Object.assign(new Error(`The download failed (HTTP ${res.status}).`), { fatal: true });
          const resumed = d.loaded > 0 && res.status === 206;
          if (!resumed) d.loaded = 0;
          const length = Number(res.headers.get('content-length'));
          if (length > 0) d.total = d.loaded + length;
          const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
          try {
            for await (const chunk of res.body) {
              if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
              d.loaded += chunk.length;
              failures = 0;
              if (Date.now() - lastEmit > 300) {
                lastEmit = Date.now();
                emit();
              }
            }
          } finally {
            await new Promise((r) => out.end(r));
          }
          if (d.total && d.loaded !== d.total) throw new Error('The download stopped early.');
          break;
        } catch (err) {
          if (d.controller.signal.aborted || err.fatal || ++failures > DOWNLOAD_RETRIES) throw err;
          await sleep(Math.min(30000, 1000 * 2 ** failures));
        }
      }
      fs.renameSync(part, fileOf(m));
      emit({ done: true });
    } catch (err) {
      fs.rmSync(part, { force: true });
      emit({ done: true, error: d.controller.signal.aborted ? 'cancelled' : `${err.message} Check the connection and try again.` });
    } finally {
      downloads.delete(m.id);
    }
  }

  function cancelDownload(id) {
    const d = downloads.get(id);
    if (d) d.controller.abort();
  }

  function deleteModel(id) {
    const m = byId(id);
    if (server && server.modelId === m.id) stop();
    fs.rmSync(fileOf(m), { force: true });
  }

  function stop() {
    clearTimeout(idleTimer);
    if (server) {
      server.dead = true;
      server.proc.kill();
      server = null;
    }
  }

  // Starts whisper-server with the model (loading a large model takes a few seconds).
  function ensureServer(m) {
    if (server && server.modelId === m.id && !server.dead) return server.ready;
    stop();
    const s = { modelId: m.id, dead: false, log: '' };
    s.ready = (async () => {
      s.port = await freePort();
      // Leave a core for the rest of the computer.
      const threads = Math.max(2, Math.min(8, os.cpus().length - 1));
      s.proc = spawn(exe, ['-m', fileOf(m), '--host', '127.0.0.1', '--port', String(s.port), '-t', String(threads), '-nt', '-l', 'auto'], {
        cwd: binDir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
      });
      s.proc.stderr.on('data', (chunk) => { s.log = (s.log + chunk).slice(-4000); });
      s.proc.on('error', (err) => { s.dead = true; s.log += `\n${err.message}`; });
      s.proc.on('exit', () => {
        s.dead = true;
        if (server === s) server = null;
      });
      const until = Date.now() + 120000;
      while (Date.now() < until) {
        if (s.dead) {
          const last = s.log.trim().split('\n').pop() || 'it closed';
          throw new Error(`Speech recognition couldn't start (${last}).`);
        }
        try {
          const res = await fetch(`http://127.0.0.1:${s.port}/`);
          if (res.ok) return;
        } catch {
          // not listening yet (still loading the model)
        }
        await sleep(250);
      }
      throw new Error('Speech recognition took too long to start.');
    })();
    s.ready.catch(() => { if (server === s) stop(); });
    server = s;
    return s.ready;
  }

  // wav: 16 kHz mono WAV. lang: 'ar', 'en' or 'auto'. Returns { text }.
  // Whisper normally works on 30 seconds of sound however little was said.
  // The small model is as accurate and about twice as fast with a window
  // sized to the recording (opts.fullWindow turns this off); the large one
  // then makes mistakes, so it always gets the full 30 seconds.
  async function transcribe(wav, lang, modelId, opts = {}) {
    const m = byId(modelId);
    if (!fs.existsSync(exe)) throw new Error("Speech recognition isn't included in this copy of Balimda.");
    if (!fs.existsSync(fileOf(m))) throw new Error(`Download the speech model first (Settings → Voice → ${m.name}).`);
    clearTimeout(idleTimer);
    await ensureServer(m);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.append('language', ['ar', 'en', 'auto'].includes(lang) ? lang : 'auto');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    form.append('no_timestamps', 'true');
    const seconds = Math.max(0, wav.length - 44) / (16000 * 2);
    if (m.sizedWindow && !opts.fullWindow && seconds < 25) form.append('audio_ctx', String(Math.max(750, Math.ceil(seconds * 50) + 250)));
    let json;
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/inference`, { method: 'POST', body: form });
      json = await res.json();
    } catch (err) {
      stop();
      throw new Error(`Speech recognition stopped (${err.message}). Try again.`);
    }
    idleTimer = setTimeout(stop, IDLE_STOP_MS);
    if (idleTimer.unref) idleTimer.unref();
    if (json.error) throw new Error(`Speech recognition failed: ${json.error}`);
    return { text: cleanTranscript(json.text) };
  }

  return { status, download, cancelDownload, deleteModel, transcribe, stop };
}

module.exports = { createVoice, cleanTranscript, WHISPER_MODELS };
