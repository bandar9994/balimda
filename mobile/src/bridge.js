// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

// Mobile (Capacitor) implementation of the `window.balimda` API that the shared
// UI in renderer/app.js talks to. On desktop the same API comes from
// preload.js + main.js; here everything runs inside the app's web view.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { App } from '@capacitor/app';
import { Share } from '@capacitor/share';
import { Storage } from '../../src/storage.js';
import { PROVIDERS, hermesProvider, normalizeMessages } from '../../src/providers.js';
import { makeNativeFetch } from '../../src/native-fetch.js';
import { readLink } from '../../src/link-reader.js';
import { chatWithTools, combineTools, TOOL_KINDS } from '../../src/tool-chat.js';
import { connectorHub, connectorsNote, urlOf } from '../../src/connectors.js';
import { httpTransport } from '../../src/mcp-client.js';
import { localApprovals } from '../../src/local-approvals.js';
import { textBrowser, browsingNote } from '../../src/browser-tools.js';
import { nativeBrowser } from '../../src/browser-native.js';
import { Sync, SyncError } from '../../src/sync.js';
import { remoteComputers } from '../../src/remote.js';
import * as local from './on-device.js';
import * as native from './native-engine.js';

const Voice = registerPlugin('Voice');
const ROOT = 'balimda-data';
const isNative = Capacitor.isNativePlatform();

// ---- file storage in the app's private data folder ------------------------

const fsBackend = {
  async read(name) {
    try {
      const r = await Filesystem.readFile({ path: `${ROOT}/${name}`, directory: Directory.Data, encoding: Encoding.UTF8 });
      return typeof r.data === 'string' ? r.data : await r.data.text();
    } catch {
      return null;
    }
  },
  // Write a temp file, then rename over the real one, so a crash can't corrupt it.
  async write(name, text) {
    const path = `${ROOT}/${name}`;
    const tmp = `${path}.tmp`;
    await Filesystem.writeFile({ path: tmp, data: text, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
    try {
      await Filesystem.rename({ from: tmp, to: path, directory: Directory.Data, toDirectory: Directory.Data });
    } catch {
      await Filesystem.writeFile({ path, data: text, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
      await Filesystem.deleteFile({ path: tmp, directory: Directory.Data }).catch(() => {});
    }
  },
  async remove(name) {
    await Filesystem.deleteFile({ path: `${ROOT}/${name}`, directory: Directory.Data }).catch(() => {});
  },
  async list(dir) {
    try {
      const r = await Filesystem.readdir({ path: `${ROOT}/${dir}`, directory: Directory.Data });
      return r.files.map((f) => (typeof f === 'string' ? f : f.name));
    } catch {
      return [];
    }
  },
  async mkdir(dir) {
    await Filesystem.mkdir({ path: `${ROOT}/${dir}`, directory: Directory.Data, recursive: true }).catch(() => {});
  }
};

// Phones can't reach a PC's "localhost", so local servers start switched off
// and on-device models are the default.
const MOBILE_DEFAULTS = {
  sendOnEnter: false,
  defaultModel: { provider: 'onDevice', model: '' },
  historyLimit: 0,
  providers: {
    onDevice: { enabled: true, contextSize: 4096, useGpu: false, nativeGpu: true },
    computer: { enabled: true },
    ollama: { enabled: false, baseUrl: 'http://192.168.1.10:11434' },
    openaiCompatible: { enabled: false, baseUrl: 'http://192.168.1.10:1234/v1', apiKey: '' },
    hermes: { enabled: false, baseUrl: 'http://192.168.1.10:8642/v1', apiKey: '', shareMemory: false }
  }
};

const ready = Storage.open(fsBackend, { defaults: MOBILE_DEFAULTS });

// Google sign-in for Drive sync: through Google Play services on Android
// (android/.../GoogleAuthPlugin.java), and Apple's sign-in sheet on iPhone
// (native/llama/ios/.../GoogleAuthPlugin.swift). The plugin keeps the grant
// and renews tokens; we only cache the current access token for a while.
const GoogleAuth = registerPlugin('GoogleAuth');
// On iPhone it needs the Google client ID in the build (Info.plist), so ask.
async function googleAuthAvailable() {
  if (!isNative || !Capacitor.isPluginAvailable('GoogleAuth')) return false;
  if (Capacitor.getPlatform() !== 'ios') return true;
  try {
    return !!(await GoogleAuth.status()).configured;
  } catch {
    return false;
  }
}

function nativeGoogleAuth() {
  let cached = null;  // { token, until }
  const call = async (method, opts) => {
    try {
      return await GoogleAuth[method](opts);
    } catch (err) {
      const e = new SyncError(err.message || 'Google sign-in failed.');
      e.offline = err.code === 'NETWORK';
      throw e;
    }
  };
  const remember = (r) => {
    cached = { token: r.accessToken, until: Date.now() + 45 * 60 * 1000 };
    return r.accessToken;
  };
  return {
    // Always offers the choice of account, so another one can be picked.
    // The account (Android tells us which) is kept as the sync "secret", so
    // renewing access stays on it.
    async signIn() {
      const r = await call('authorize', { interactive: true, chooseAccount: true });
      remember(r);
      return { account: r.email || null, secret: r.email || null };
    },
    async accessToken(account, { force = false } = {}) {
      if (!force && cached && Date.now() < cached.until) return cached.token;
      if (force && cached) await call('clearToken', { token: cached.token }).catch(() => {});
      return remember(await call('authorize', { interactive: false, ...(account ? { account } : {}) }));
    },
    async signOut(_secret, email) {
      cached = null;
      await call('signOut', { email }).catch(() => {});
    }
  };
}

// Chat sync with the desktop app (see src/sync.js).
const syncListeners = new Set();
const syncReady = ready.then(async (storage) => {
  const sync = new Sync({
    storage,
    device: `phone (${Capacitor.getPlatform()})`,
    googleAuth: (await googleAuthAvailable()) ? nativeGoogleAuth() : null,
    onEvent: (evt) => {
      for (const cb of syncListeners) cb(evt);
      // New data from this phone: the computers sync at once (see remote.js).
      if (evt.type === 'pushed') computers.pushed().catch(() => {});
    }
  });
  await sync.load();
  return sync;
});
const withSync = (fn) => async (...args) => fn(await syncReady, ...args);

// On-device engine: native llama.cpp (CPU + Adreno GPU) when the Android app
// has it, otherwise llama.cpp compiled to WebAssembly.
const nativeInfo = isNative && Capacitor.isPluginAvailable('Llama')
  ? native.probe()
  : Promise.resolve({ available: false, devices: [] });
const engine = async () => ((await nativeInfo).available ? native : local);
const chatEngine = async () => ((await nativeInfo).available ? native.nativeEngine : local.onDevice);

// The models of the user's computers, over Wi-Fi (see src/remote.js).
const computers = remoteComputers({
  getKey: async () => (await syncReady).linkKey(),
  getComputers: async () => (await (await ready).getSettings()).computers
});

// The phone's own network code, for requests the web view can't make: Hermes
// refuses the web view's requests unless its API_SERVER_CORS_ORIGINS lists the
// app, and other websites (for "Read links") don't allow the app's page at all.
const NetPlugin = isNative && Capacitor.isPluginAvailable('Net') ? registerPlugin('Net') : null;
const nativeFetch = NetPlugin ? makeNativeFetch(NetPlugin) : null;

// While a reply is written, the app keeps going in the background: Android
// with a foreground service (a notification), iPhone with the extra time it
// allows. Otherwise leaving the app cuts the reply's connection off.
let repliesRunning = 0;
function replyRunning(delta) {
  const before = repliesRunning;
  repliesRunning = Math.max(0, repliesRunning + delta);
  if (!NetPlugin || !before === !repliesRunning) return;
  Promise.resolve(NetPlugin.replying({ on: repliesRunning > 0 })).catch(() => {});  // (older app: no such method)
}
// When the app last went to the background, to tell a reply cut off by that
// from one that failed.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
});
const hermes = nativeFetch ? { ...PROVIDERS.hermes, impl: hermesProvider(nativeFetch) } : PROVIDERS.hermes;

// The browser for models: a hidden web view of the app's own (search, open,
// click, type, screenshots), or pages as text where the app doesn't have one.
// Which store this Android build was made for (see android/app/build.gradle,
// NAJWA_STORE): "play" for the Google Play build, "" otherwise. If the app
// can't say, it reports "unknown", which hides what Play doesn't allow.
const buildStore = Capacitor.getPlatform() === 'android'
  ? registerPlugin('Store').info().then((r) => String((r && r.store) || ''), () => 'unknown')
  : Promise.resolve('');

const Browse = isNative && Capacitor.isPluginAvailable('Browse') ? registerPlugin('Browse') : null;
const webFetch = nativeFetch || ((...args) => fetch(...args));
const modelBrowser = () => (Browse ? nativeBrowser(Browse, { doFetch: webFetch }) : textBrowser(webFetch));

// Connectors on the internet (Settings → Connectors). Programs on a computer
// only run in the desktop app.
const connectorsHub = connectorHub({
  transportFor: (c) => httpTransport({ url: urlOf(c), headers: c.token ? { Authorization: `Bearer ${c.token}` } : {}, doFetch: webFetch })
});
const approvals = localApprovals();
// This phone, for questions its connectors ask (see src/local-approvals.js).
async function phoneId() {
  const storage = await ready;
  const state = await storage.getState();
  if (state.deviceId) return state.deviceId;
  const id = globalThis.crypto.randomUUID();
  await storage.saveState({ deviceId: id });
  return id;
}
// How this phone is called on other devices ("Replying on Android phone…").
const phoneName = () => (Capacitor.getPlatform() === 'ios' ? 'iPhone' : Capacitor.getPlatform() === 'android' ? 'Android phone' : 'Browser');
const phoneOrigin = async () => ({ id: await phoneId(), name: `your ${Capacitor.getPlatform() === 'ios' ? 'iPhone' : 'phone'}`, computer: false });
const phoneConnectors = (list) => (list || []).filter((c) => c.enabled !== false && c.kind !== 'command');

const providers = {
  onDevice: {
    label: 'On this device (offline)',
    impl: {
      listModels: async (cfg) => (await chatEngine()).listModels(cfg),
      streamChat: async (...args) => (await chatEngine()).streamChat(...args)
    }
  },
  computer: {
    label: 'On your computer',
    impl: computers
  },
  ...PROVIDERS,
  hermes
};

// ---- helpers ---------------------------------------------------------------

async function shareFile(fileName, text, mime) {
  if (!isNative) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return { filePath: fileName };
  }
  const written = await Filesystem.writeFile({
    path: fileName,
    data: text,
    directory: Directory.Cache,
    encoding: Encoding.UTF8
  });
  await Share.share({ title: fileName, files: [written.uri] });
  return { filePath: fileName };
}

function pickTextFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      resolve(file ? await file.text() : null);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

function chatToMarkdown(chat) {
  const lines = [`# ${chat.title}`, ''];
  for (const m of chat.messages) {
    // A reasoning model's thinking isn't part of the reply.
    const text = String(m.content || '').replace(/^\s*<think>[\s\S]*?(<\/think>|$)\s*/, '');
    // Pictures stay in the file, as data URLs.
    const pics = (Array.isArray(m.images) ? m.images : []).filter((u) => typeof u === 'string' && u.startsWith('data:image/'));
    lines.push(`## ${m.role === 'user' ? 'You' : 'Assistant'}`, '', ...pics.map((u, i) => `![Picture ${i + 1}](${u})\n`), text, '');
  }
  return lines.join('\n');
}

// A file name from a chat title, keeping letters in any language (Arabic too).
const safeName = (s) => String(s || '').replace(/[^\p{L}\p{N}\- ]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'chat';

// ---- the API ---------------------------------------------------------------

const active = new Map();
const steering = new Map(); // requestId -> { send } while a reply can take messages mid-way
const aiListeners = new Set();
const menuListeners = new Set();

const withStorage = (fn) => async (...args) => fn(await ready, ...args);

window.balimda = {
  chats: {
    list: withStorage((s) => s.listChats()),
    search: withStorage((s, q) => s.searchChats(q)),
    recall: withStorage((s, q, opts) => s.recall(q, opts)),
    get: withStorage((s, id) => s.getChat(id)),
    create: withStorage((s, init) => s.createChat(init)),
    save: withStorage((s, chat) => s.saveChat(structuredClone(chat))),
    remove: withStorage((s, id) => s.deleteChat(id)),
    exportMarkdown: withStorage(async (s, id) => {
      const chat = await s.getChat(id);
      return chat ? shareFile(`${safeName(chat.title)}.md`, chatToMarkdown(chat), 'text/markdown') : null;
    })
  },
  settings: {
    get: withStorage((s) => s.getSettings()),
    save: withStorage((s, settings) => s.saveSettings(settings))
  },
  state: {
    get: withStorage((s) => s.getState()),
    save: withStorage((s, patch) => s.saveState(patch))
  },
  backup: {
    exportAll: withStorage(async (s) => {
      const data = await s.exportAll();
      const stamp = new Date().toISOString().slice(0, 10);
      await shareFile(`najwa-ai-backup-${stamp}.json`, JSON.stringify(data, null, 2), 'application/json');
      return { count: data.chats.length };
    }),
    importAll: withStorage(async (s) => {
      const text = await pickTextFile('application/json,.json');
      if (!text) return null;
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('This file isn\'t a Najwa AI backup (it can\'t be read as one).');
      }
      return { count: await s.importAll(data) };
    })
  },
  app: {
    // The app's language, for Android's notifications (older app: no such method).
    async language(lang) {
      try {
        if (NetPlugin) await NetPlugin.language({ lang });
      } catch {
        // keep English notifications
      }
    },
    async info() {
      let version = '1.0.0';
      if (isNative) {
        try {
          version = (await App.getInfo()).version;
        } catch {
          // keep default
        }
      }
      return {
        version,
        deviceId: await phoneId(),
        deviceName: phoneName(),
        dataDir: 'Private app storage on this phone',
        platform: Capacitor.getPlatform(),
        appName: 'Najwa AI',
        store: await buildStore,
        icon: 'icon.png',
        mobile: true,
        onDevice: true,
        providers: Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, v.label]))
      };
    },
    async openDataDir() {},
    // LICENSE / THIRD-PARTY-NOTICES.md, copied next to the app by build-web.
    async legal(which) {
      const res = await fetch(which === 'notices' ? 'THIRD-PARTY-NOTICES.md' : 'LICENSE.txt');
      return res.text();
    },
    async exit() {
      // Android only: iOS apps don't close or minimize themselves.
      if (Capacitor.getPlatform() === 'android') await App.minimizeApp();
    }
  },
  web: {
    read: (url) => readLink(url, nativeFetch || ((...args) => fetch(...args)))
  },
  connectors: {
    test: (c) => (c && c.kind === 'command'
      ? Promise.resolve({ ok: false, error: 'Programs only run in the desktop app.' })
      : connectorsHub.test(c))
  },
  ai: {
    async models(providerId) {
      const provider = providers[providerId];
      if (!provider) throw new Error(`Unknown provider: ${providerId}`);
      const cfg = (await (await ready).getSettings()).providers[providerId] || {};
      return provider.impl.listModels(cfg);
    },
    async chat(req) {
      const provider = providers[req.provider];
      if (!provider) return { ok: false, error: `Unknown provider: ${req.provider}` };
      const cfg = (await (await ready).getSettings()).providers[req.provider] || {};
      const controller = new AbortController();
      active.set(req.requestId, controller);
      const steer = { send: null };
      steering.set(req.requestId, steer);
      const startedAt = Date.now();
      if (!req.background) replyRunning(1);
      try {
        const request = {
          model: req.model,
          system: req.system,
          messages: normalizeMessages(req.messages),
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          think: req.think,
          background: !!req.background,
          // "Let models use a browser" and connectors: a computer's models use
          // the computer's own.
          browse: !!req.browse,
          connectors: !!req.connectors,
          chatId: req.chatId,
          steering: steer,
          // Hermes: follow a run that is already going (a reply cut off when
          // the app was closed) instead of starting one.
          ...(req.resumeRun ? { resumeRun: String(req.resumeRun) } : {})
        };
        if (req.provider === 'computer') {
          // For the computer: who is asking and which message this reply is,
          // so it can keep its own copy of the reply and refuse a second
          // reply in the same chat (see src/reply-hub.js).
          request.device = { id: await phoneId(), name: phoneName() };
          if (req.replyId) request.reply = { id: String(req.replyId), at: req.replyAt, model: req.replyModel || null };
          // The computer needs this chat to put the reply in: sync it now.
          if (req.chatId) syncReady.then((sync) => sync.run()).catch(() => {});
        }
        const onDelta = (text) => {
          for (const cb of aiListeners) cb({ requestId: req.requestId, type: 'delta', text });
        };
        const onInfo = (info) => {
          for (const cb of aiListeners) cb({ requestId: req.requestId, type: 'info', ...info });
        };
        if (TOOL_KINDS[req.provider] && (req.browse || req.connectors)) {
          const sets = [];
          let system = request.system;
          const browser = req.browse ? modelBrowser() : null;
          try {
            if (browser) {
              sets.push(browser);
              system = browsingNote(system, !!Browse);
            }
            const mine = req.connectors ? phoneConnectors((await (await ready).getSettings()).connectors) : [];
            if (mine.length) {
              const set = await connectorsHub.toolset(mine, {
                approve: approvals.asker(onInfo, controller.signal, await phoneOrigin()), allowed: approvals.allowedFor(req.chatId), signal: controller.signal
              });
              sets.push(set);
              system = connectorsNote(system, set);
            }
            const tools = combineTools(sets);
            if (tools.defs.length) {
              const result = await chatWithTools({
                kind: TOOL_KINDS[req.provider], cfg, req: { ...request, system }, onDelta, signal: controller.signal, onInfo, tools
              });
              if (!result.fallback) return { ok: true, ...result };
              // Messages sent meanwhile go as the next message.
              if (result.pendingSteer) {
                const plain = await provider.impl.streamChat(cfg, request, onDelta, controller.signal, onInfo);
                return { ok: true, ...plain, pendingSteer: result.pendingSteer };
              }
            }
          } finally {
            if (browser) browser.close();
          }
        }
        const result = await provider.impl.streamChat(cfg, request, onDelta, controller.signal, onInfo);
        return { ok: true, ...result };
      } catch (err) {
        if (controller.signal.aborted) return { ok: true, aborted: true };
        let message = err.message || String(err);
        const network = err instanceof TypeError && !err.explained && /fetch|network|load failed|connection/i.test(message);
        // The app went to the background while it was writing, and that cut
        // the connection: the app finishes the reply when you come back.
        if (network && hiddenAt >= startedAt) {
          return { ok: false, code: 'cutOff', error: 'The connection was lost while Najwa AI was in the background.' };
        }
        if (network) {
          message = `Couldn't reach the server (${message}). Check the address in Settings, and that the server allows connections from other devices.`;
        }
        return { ok: false, error: message, ...(err.code === 'busy' || err.code === 'elsewhere' ? { code: err.code } : {}) };
      } finally {
        if (!req.background) replyRunning(-1);
        active.delete(req.requestId);
        steering.delete(req.requestId);
      }
    },
    // A message sent while a reply is written: true if the model reads it
    // during this reply (Hermes, or a reply using tools).
    async steer(requestId, text, id) {
      const s = steering.get(requestId);
      if (!s || !s.send) return false;
      try {
        return !!(await s.send(String(text || ''), id));
      } catch {
        return false;
      }
    },
    // Answer a question a computer asked (its connectors), over the private
    // link the phone uses for the computer's models.
    answerOn: (computerId, payload) => computers.answerOn(computerId, payload),
    // Answer an agent's request for permission (Hermes Agent), directly or
    // through the computer the phone is using.
    async approve(providerId, model, payload) {
      if (providerId === 'computer') return computers.approve(model, payload);
      if (approvals.owns(payload)) return approvals.answer(payload);
      // (asked by this phone; answerOn() is for a computer's questions)
      const provider = providers[providerId];
      if (!provider || !provider.impl.approve) throw new Error('This model can\'t take approvals.');
      const cfg = (await (await ready).getSettings()).providers[providerId] || {};
      return provider.impl.approve(cfg, payload);
    },
    async abort(requestId) {
      const c = active.get(requestId);
      if (c) c.abort();
      return !!c;
    },
    onEvent(cb) {
      aiListeners.add(cb);
      return () => aiListeners.delete(cb);
    }
  },
  // Talking instead of typing, and replies read aloud, with the phone's own
  // speech services (android/.../VoicePlugin.java, native/llama/ios/.../VoicePlugin.swift).
  voice: isNative ? {
    available: (opts) => Voice.available(opts || {}),
    listen: (opts) => Voice.listen(opts),
    stopListening: () => Voice.stopListening(),
    cancelListening: () => Voice.cancelListening(),
    speak: (opts) => Voice.speak(opts),
    stopSpeaking: () => Voice.stopSpeaking(),
    onEvent(cb) {
      const handle = Voice.addListener('voice', cb);
      return () => handle.then((h) => h.remove());
    }
  } : undefined,
  sync: {
    status: withSync((s) => s.status()),
    connect: withSync((s, opts) => s.connect(opts)),
    disconnect: withSync((s) => s.disconnect()),
    now: withSync((s) => s.run()),
    onEvent(cb) {
      syncListeners.add(cb);
      return () => syncListeners.delete(cb);
    }
  },
  onDevice: {
    async engine() {
      const info = await nativeInfo;
      const gpu = (info.devices || []).find((d) => d.type === 'gpu');
      return {
        kind: info.available ? 'native' : 'wasm',
        gpu: gpu ? gpu.description || gpu.name : null,
        error: info.error || null
      };
    },
    catalog: async () => (await engine()).CATALOG,
    list: async () => (await engine()).listDownloaded(),
    download: async (url) => (await engine()).download(url),
    cancel: async (url) => (await engine()).cancelDownload(url),
    remove: async (url) => (await engine()).remove(url),
    // A model's vision file (mmproj), so it can see pictures (native engine only).
    downloadVision: async (modelName, url) => {
      const e = await engine();
      if (!e.downloadVision) throw new Error('Pictures need the native engine, which this phone can\'t run.');
      // The model by name, or by its download link.
      return e.downloadVision(/^https?:/i.test(modelName) ? e.modelName(modelName) : modelName, url);
    },
    removeVision: async (modelName) => {
      const e = await engine();
      if (e.removeVision) await e.removeVision(modelName);
    },
    downloads: async () => (await engine()).downloadState(),
    missing: async () => {
      const e = await engine();
      return e.listMissing ? e.listMissing().catch(() => []) : [];
    },
    forget: async (name) => {
      const e = await engine();
      if (e.forgetMissing) await e.forgetMissing(name);
    },
    onProgress(cb) {
      let off = null;
      let cancelled = false;
      engine().then((e) => {
        if (!cancelled) off = e.onDownloadProgress(cb);
      });
      return () => {
        cancelled = true;
        if (off) off();
      };
    },
    // Models downloaded by the older WebAssembly engine (not usable by the
    // native one) so they can be deleted to free space.
    async legacy() {
      if (!(await nativeInfo).available) return [];
      try {
        return await local.listDownloaded();
      } catch {
        return [];
      }
    },
    removeLegacy: (url) => local.remove(url)
  },
  onMenu(cb) {
    menuListeners.add(cb);
  }
};

if (isNative) {
  App.addListener('backButton', () => {
    for (const cb of menuListeners) cb('back');
  });
}

// Sync when the app opens, when you come back to it, every 20 seconds while
// it's on screen, and when you leave it (so the PC gets your last messages).
// On leaving, the app first saves the chat it is still writing
// (renderer/app.js, saveAndSyncNow) and then syncs, so the last words reach
// the PC even when the reply was still streaming; the sync here only covers
// what was already saved. Nothing runs while the app is in the background.
//
// While on screen, the phone also stays connected to the computers it is
// linked with: a computer says when it has new data (a reply written there,
// or one it finished for this phone) and the phone syncs at once. Computers
// that don't offer that (older desktop app) are simply polled.
const VISIBLE_POLL_MS = 20 * 1000;
syncReady.then((sync) => {
  sync.run();
  let watching = null;   // AbortController of the open connections
  let notBefore = 0;     // when to try again after it ended at once (nothing to watch)
  const stopWatching = () => {
    if (watching) watching.abort();
    watching = null;
  };
  const startWatching = async () => {
    if (watching || document.visibilityState !== 'visible' || Date.now() < notBefore) return;
    const controller = new AbortController();
    watching = controller;
    const began = Date.now();
    try {
      await computers.watch({
        deviceId: await phoneId(),
        signal: controller.signal,
        onChanged: () => sync.run()
      });
    } catch {
      // nothing to watch (no computer yet): tried again at the next poll
    } finally {
      if (watching === controller) watching = null;
      // Ended at once: no computer, or only older ones. Not again for a while.
      if (!controller.signal.aborted && Date.now() - began < 5000) notBefore = Date.now() + 5 * 60 * 1000;
    }
  };
  const foreground = () => {
    sync.run();
    startWatching();
  };
  startWatching();
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    sync.run();
    startWatching();
  }, VISIBLE_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') foreground();
    else stopWatching();
  });
  if (isNative) {
    App.addListener('resume', foreground);
    App.addListener('pause', () => {
      stopWatching();
      // The web view's own "hidden" event may not come before the app is
      // frozen, so ask the app to save and sync from here too.
      window.dispatchEvent(new Event('najwa:background'));
      if (sync.pending()) sync.run();
    });
  }
});
