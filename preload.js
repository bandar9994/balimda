// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

// ---- voice: typing by talking, and reading replies aloud ---------------------------
// Listening: the microphone is recorded here until the user stops talking,
// then Whisper turns it into text on this computer (src/voice-desktop.js).
// Speaking: the computer's own voices. Same methods and events as the
// phone's Voice plugin (mobile/src/bridge.js).

const voiceListeners = new Set();
const emitVoice = (evt) => { for (const cb of voiceListeners) cb(evt); };
ipcRenderer.on('voice:event', (_e, evt) => emitVoice(evt));
const SAMPLE_RATE = 16000;
let recording = null; // { finish, cancel } while listening
let starting = null;  // { stopped } while the microphone is being opened

async function listen({ lang, model } = {}) {
  if (recording) recording.cancel();
  if (starting) starting.stopped = true;
  const start = { stopped: false };
  starting = start;
  let stream;
  try {
    await ipcRenderer.invoke('voice:askMic');
    stream = await navigator.mediaDevices.getUserMedia({
      // No automatic gain: it turns the room's noise up when you stop talking,
      // which would hide the pause. Whisper copes with quiet speech.
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false }
    });
  } catch (err) {
    throw new Error(err.name === 'NotAllowedError'
      ? "Balimda isn't allowed to use the microphone. Allow it in your computer's privacy settings (Microphone), then try again."
      : err.name === 'NotFoundError' ? 'No microphone found. Connect one and try again.' : `Couldn't use the microphone: ${err.message}`);
  } finally {
    if (starting === start) starting = null;
  }
  // Stopped or cancelled while the microphone was opening: nothing was said.
  if (start.stopped) {
    for (const t of stream.getTracks()) t.stop();
    return { text: '' };
  }
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(1024, 1, 1);
  const chunks = [];
  // Talking starts with sound clearly louder than the room's noise, and a
  // pause is sound much quieter than the voice (or back to the room's noise).
  let noise = 0;
  let noiseFrames = 0;
  let voice = 0;
  let heard = false;
  let silentMs = 0;
  let totalMs = 0;
  let lastLevel = 0;
  const audio = await new Promise((resolve) => {
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      node.disconnect();
      source.disconnect();
      for (const t of stream.getTracks()) t.stop();
      ctx.close();
      resolve(keep && heard ? chunks : null);
    };
    recording = { finish: () => finish(true), cancel: () => finish(false) };
    node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const ms = (data.length / SAMPLE_RATE) * 1000;
      totalMs += ms;
      if (totalMs < 320) {
        noise = (noise * noiseFrames + rms) / ++noiseFrames;
        return;
      }
      const threshold = Math.min(0.05, Math.max(0.01, noise * 3));
      if (!heard) {
        if (rms > threshold) {
          heard = true;
          voice = rms;
        } else {
          noise = noise * 0.9 + rms * 0.1; // follow the room
        }
      } else {
        voice = Math.max(voice * 0.995, rms); // the voice's loudness, falling slowly after words
        if (rms < Math.max(threshold, voice * 0.2)) silentMs += ms;
        else silentMs = 0;
      }
      if (Date.now() - lastLevel > 100) {
        lastLevel = Date.now();
        emitVoice({ level: Math.min(1, rms / (threshold * 4)) });
      }
      if (heard && silentMs > 1300) finish(true);         // a pause: done talking
      else if (!heard && totalMs > 8000) finish(false);   // nothing said
      else if (totalMs > 60000) finish(true);             // a minute at most
    };
    source.connect(node);
    node.connect(ctx.destination); // (silent) keeps the recorder running
    emitVoice({ state: 'listening' });
  });
  recording = null;
  if (!audio) return { text: '' };
  emitVoice({ state: 'thinking' });
  const whisperLang = /^ar/i.test(lang || '') ? 'ar' : /^en/i.test(lang || '') ? 'en' : 'auto';
  return ipcRenderer.invoke('voice:transcribe', toWav(audio), whisperLang, model);
}

// 16-bit mono WAV, which Whisper reads.
function toWav(chunks) {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples * 2, true);
  let off = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, off += 2) v.setInt16(off, Math.max(-1, Math.min(1, c[i])) * 0x7fff, true);
  }
  return buf;
}

async function systemVoices() {
  let list = speechSynthesis.getVoices();
  if (list.length) return list;
  await new Promise((r) => {
    speechSynthesis.addEventListener('voiceschanged', r, { once: true });
    setTimeout(r, 1500);
  });
  return speechSynthesis.getVoices();
}

// The best voice for a language: the exact one (ar-SA), or any of that language.
function voiceFor(list, lang) {
  const norm = (l) => l.toLowerCase().replace('_', '-');
  const want = norm(lang);
  return list.find((v) => norm(v.lang) === want && v.localService) || list.find((v) => norm(v.lang) === want) ||
    list.find((v) => norm(v.lang).startsWith(want.slice(0, 2)) && v.localService) || list.find((v) => norm(v.lang).startsWith(want.slice(0, 2)));
}

const speaking = new Set(); // utterances being spoken (kept, or Chromium may drop their "end")
let spoken = 0; // bumped by stopSpeaking, so a sentence still waiting for the voices isn't read after it

async function speak({ text, lang = 'en-US', rate = 1 } = {}) {
  const round = spoken;
  const voice = voiceFor(await systemVoices(), lang);
  if (round !== spoken) return { interrupted: true };
  if (!voice) {
    const name = /^ar/i.test(lang) ? 'Arabic' : 'English';
    throw new Error(`This computer has no ${name} voice to read replies. Windows: Settings → Time & language → Speech → Add voices. ` +
      `Mac: System Settings → Accessibility → Spoken Content → System voice → Manage Voices. Then restart Balimda.`);
  }
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = rate;
    speaking.add(u);
    u.onend = () => { speaking.delete(u); resolve({ interrupted: false }); };
    u.onerror = (e) => { speaking.delete(u); resolve({ interrupted: e.error === 'interrupted' || e.error === 'canceled' }); };
    speechSynthesis.speak(u);
  });
}

contextBridge.exposeInMainWorld('balimda', {
  chats: {
    list: invoke('chats:list'),
    search: invoke('chats:search'),
    recall: invoke('chats:recall'),
    get: invoke('chats:get'),
    create: invoke('chats:create'),
    save: invoke('chats:save'),
    remove: invoke('chats:delete'),
    exportMarkdown: invoke('chat:exportMarkdown')
  },
  settings: {
    get: invoke('settings:get'),
    save: invoke('settings:save')
  },
  state: {
    get: invoke('state:get'),
    save: invoke('state:save')
  },
  backup: {
    exportAll: invoke('backup:export'),
    importAll: invoke('backup:import')
  },
  app: {
    info: invoke('app:info'),
    openDataDir: invoke('app:openDataDir'),
    legal: invoke('app:legal')
  },
  ai: {
    models: invoke('ai:models'),
    chat: invoke('ai:chat'),
    abort: invoke('ai:abort'),
    approve: invoke('ai:approve'),
    onEvent(cb) {
      const listener = (_e, evt) => cb(evt);
      ipcRenderer.on('ai:event', listener);
      return () => ipcRenderer.removeListener('ai:event', listener);
    }
  },
  sync: {
    status: invoke('sync:status'),
    connect: invoke('sync:connect'),
    disconnect: invoke('sync:disconnect'),
    now: invoke('sync:now'),
    onEvent(cb) {
      const listener = (_e, evt) => cb(evt);
      ipcRenderer.on('sync:event', listener);
      return () => ipcRenderer.removeListener('sync:event', listener);
    }
  },
  voice: {
    async available() {
      const [s, voices] = await Promise.all([ipcRenderer.invoke('voice:status'), systemVoices()]);
      return {
        desktop: true,
        recognition: s.available,
        onDevice: true,
        needsModel: !s.models.some((m) => m.downloaded),
        tts: voices.length > 0,
        models: s.models,
        recommended: s.recommended
      };
    },
    status: invoke('voice:status'),
    download: invoke('voice:download'),
    cancelDownload: invoke('voice:cancelDownload'),
    deleteModel: invoke('voice:deleteModel'),
    listen,
    async stopListening() {
      if (recording) recording.finish();
      if (starting) starting.stopped = true;
    },
    async cancelListening() {
      if (recording) recording.cancel();
      if (starting) starting.stopped = true;
    },
    speak,
    async stopSpeaking() {
      spoken++;
      speechSynthesis.cancel();
      speaking.clear();
    },
    onEvent(cb) {
      voiceListeners.add(cb);
      return () => voiceListeners.delete(cb);
    }
  },
  // Sharing this computer's models with the phone.
  remote: {
    status: invoke('remote:status'),
    onStatus(cb) {
      const listener = (_e, status) => cb(status);
      ipcRenderer.on('remote:status', listener);
      return () => ipcRenderer.removeListener('remote:status', listener);
    }
  },
  onMenu(cb) {
    ipcRenderer.on('menu', (_e, action) => cb(action));
  }
});
