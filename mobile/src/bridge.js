// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Mobile (Capacitor) implementation of the `window.balimda` API that the shared
// UI in renderer/app.js talks to. On desktop the same API comes from
// preload.js + main.js; here everything runs inside the app's web view.

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { App } from '@capacitor/app';
import { Share } from '@capacitor/share';
import { Storage } from '../../src/storage.js';
import { PROVIDERS, normalizeMessages } from '../../src/providers.js';
import { Sync } from '../../src/sync.js';
import * as local from './on-device.js';
import * as native from './native-engine.js';

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
    ollama: { enabled: false, baseUrl: 'http://192.168.1.10:11434' },
    openaiCompatible: { enabled: false, baseUrl: 'http://192.168.1.10:1234/v1', apiKey: '' }
  }
};

const ready = Storage.open(fsBackend, { defaults: MOBILE_DEFAULTS });

// Chat sync with the desktop app (see src/sync.js).
const syncListeners = new Set();
const syncReady = ready.then(async (storage) => {
  const sync = new Sync({
    storage,
    device: `phone (${Capacitor.getPlatform()})`,
    onEvent: (evt) => {
      for (const cb of syncListeners) cb(evt);
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

const providers = {
  onDevice: {
    label: 'On this device (offline)',
    impl: {
      listModels: async (cfg) => (await chatEngine()).listModels(cfg),
      streamChat: async (...args) => (await chatEngine()).streamChat(...args)
    }
  },
  ...PROVIDERS
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
  for (const m of chat.messages) lines.push(`## ${m.role === 'user' ? 'You' : 'Assistant'}`, '', m.content || '', '');
  return lines.join('\n');
}

const safeName = (s) => s.replace(/[^\w\- ]+/g, '').trim() || 'chat';

// ---- the API ---------------------------------------------------------------

const active = new Map();
const aiListeners = new Set();
const menuListeners = new Set();

const withStorage = (fn) => async (...args) => fn(await ready, ...args);

window.balimda = {
  chats: {
    list: withStorage((s) => s.listChats()),
    search: withStorage((s, q) => s.searchChats(q)),
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
      await shareFile(`balimda-backup-${stamp}.json`, JSON.stringify(data, null, 2), 'application/json');
      return { count: data.chats.length };
    }),
    importAll: withStorage(async (s) => {
      const text = await pickTextFile('application/json,.json');
      if (!text) return null;
      return { count: await s.importAll(JSON.parse(text)) };
    })
  },
  app: {
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
        dataDir: 'Private app storage on this phone',
        platform: Capacitor.getPlatform(),
        appName: 'Balimda',
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
      if (isNative) await App.minimizeApp();
    }
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
      try {
        const result = await provider.impl.streamChat(
          cfg,
          {
            model: req.model,
            system: req.system,
            messages: normalizeMessages(req.messages),
            temperature: req.temperature,
            maxTokens: req.maxTokens
          },
          (text) => {
            for (const cb of aiListeners) cb({ requestId: req.requestId, type: 'delta', text });
          },
          controller.signal
        );
        return { ok: true, ...result };
      } catch (err) {
        if (controller.signal.aborted) return { ok: true, aborted: true };
        let message = err.message || String(err);
        if (err instanceof TypeError && /fetch|network|load failed/i.test(message)) {
          message = `Couldn't reach the server (${message}). Check the address in Settings, and that the server allows connections from other devices.`;
        }
        return { ok: false, error: message };
      } finally {
        active.delete(req.requestId);
      }
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
    downloads: async () => (await engine()).downloadState(),
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

// Sync when the app opens, when you come back to it, every minute while it's
// on screen, and when you leave it (so the PC gets your last messages).
syncReady.then((sync) => {
  sync.run();
  setInterval(() => {
    if (document.visibilityState === 'visible') sync.run();
  }, 60 * 1000);
  document.addEventListener('visibilitychange', () => sync.run());
  if (isNative) {
    App.addListener('resume', () => sync.run());
    App.addListener('pause', () => {
      if (sync.pending()) sync.run();
    });
  }
});
