// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Persistent storage for chats, settings and app state.
// Everything is plain JSON files so it is easy to back up, sync or inspect.
// The actual file access comes from a backend, so the same logic runs on
// desktop (Node fs) and mobile (Capacitor Filesystem):
//
//   backend.read(name)        -> Promise<string | null>
//   backend.write(name, text) -> Promise<void>   (should be atomic)
//   backend.remove(name)      -> Promise<void>   (no error if missing)
//   backend.list(dir)         -> Promise<string[]> file names in dir
//   backend.mkdir(dir)        -> Promise<void>

const DEFAULT_SETTINGS = {
  theme: 'system',
  defaultModel: { provider: 'ollama', model: '' },
  autoTitle: true,
  sendOnEnter: true,
  temperature: 0.7,
  maxTokens: 0,
  historyLimit: 0,
  memoryEnabled: true,
  autoMemory: true,
  recallChats: true,
  memory: '',
  computers: {},
  shareWithPhone: false,
  providers: {
    ollama: { enabled: true, baseUrl: 'http://127.0.0.1:11434', think: true },
    openaiCompatible: { enabled: true, baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '' },
    anthropic: { enabled: true, apiKey: '' },
    openai: { enabled: true, baseUrl: 'https://api.openai.com/v1', apiKey: '' }
  },
  assistants: [
    {
      id: 'default',
      name: 'Assistant',
      emoji: '🤖',
      systemPrompt: 'You are a helpful, friendly assistant. Answer clearly and concisely.'
    },
    {
      id: 'coder',
      name: 'Code Buddy',
      emoji: '💻',
      systemPrompt: 'You are an expert software engineer. Give correct, well-explained code and point out pitfalls.'
    },
    {
      id: 'writer',
      name: 'Writing Coach',
      emoji: '✍️',
      systemPrompt: 'You are a thoughtful writing coach. Help the user write clearly, improve drafts, and keep their voice.'
    }
  ]
};

const ID_RE = /^[A-Za-z0-9-]+$/;

// Settings that follow the user between devices when sync is on. Server
// addresses and API keys differ per device, so they stay local. `computers`
// lists the computers that share their models with the phone (see
// src/remote.js); only publishComputer changes it.
const SHARED_SETTINGS = ['assistants', 'memory', 'memoryEnabled', 'autoMemory', 'recallChats', 'computers'];

function pickShared(settings) {
  return Object.fromEntries(SHARED_SETTINGS.map((k) => [k, settings[k]]));
}

function newId() {
  return globalThis.crypto.randomUUID();
}

// Short one-line preview, without a reasoning model's <think> block.
function previewText(text) {
  return String(text)
    .replace(/^\s*<think>[\s\S]*?(<\/think>|$)/, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

// Chats and settings saved before the rename used "pal" names; read them as
// assistants so old data and backups keep working.
function upgradeChat(chat) {
  if (chat && 'palId' in chat) {
    if (!chat.assistantId) chat.assistantId = chat.palId;
    delete chat.palId;
  }
  return chat;
}

// ---- recall: finding relevant bits of earlier chats ----------------------

const STOPWORDS = new Set((
  'the and for are but not you your yours with this that these those have has had was were will would could should ' +
  'can what when where which who why how all any some from into onto about than then them they their there here ' +
  'just also very more most much many such only own same too out off over under again once been being does did ' +
  'doing its it\'s i\'m you\'re let make like want need please tell give show help thanks thank okay yes one two ' +
  'في من على الى إلى عن مع هذا هذه ذلك تلك التي الذي الذين ما ماذا هل ان أن إن او أو كان كانت يكون لكن ثم قد لا لم لن ' +
  'كل بعض عند كيف متى اين أين لماذا انا أنا انت أنت هو هي نحن هم لي لك له لها'
).split(/\s+/));

// Lower-case words of 3+ letters, with light Arabic normalisation.
function terms(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')          // Arabic diacritics and tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .match(/[\p{L}\p{N}]{3,}/gu) || [];
  return words
    .map((w) => (/^ال[\u0600-\u06FF]{3,}$/.test(w) ? w.slice(2) : w))
    .filter((w) => !STOPWORDS.has(w));
}

// A short excerpt of `text` around the first word that matched.
function excerpt(text, hits, max) {
  const clean = String(text).replace(/^\s*<think>[\s\S]*?(<\/think>|$)/, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const lower = clean.toLowerCase();
  let at = -1;
  for (const h of hits) {
    const i = lower.indexOf(h);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, Math.min(at - Math.floor(max / 3), clean.length - max));
  return `${start > 0 ? '…' : ''}${clean.slice(start, start + max).trim()}${start + max < clean.length ? '…' : ''}`;
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Merge saved settings over defaults so new settings keys appear after upgrades.
function mergeDefaults(defaults, saved) {
  if (!isPlainObject(saved)) return structuredClone(defaults);
  const out = structuredClone(defaults);
  for (const [k, v] of Object.entries(saved)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeDefaults(out[k], v);
    else out[k] = v;
  }
  return out;
}

class Storage {
  /**
   * @param backend  file backend (see top of file)
   * @param [options.secrets]   { encrypt(s), decrypt(s) } for API keys
   * @param [options.defaults]  platform-specific overrides of DEFAULT_SETTINGS
   */
  static async open(backend, options = {}) {
    const storage = new Storage(backend, options);
    await backend.mkdir('chats');
    storage.index = await storage._loadIndex();
    return storage;
  }

  constructor(backend, { secrets = {}, defaults = {} } = {}) {
    this.backend = backend;
    this.encrypt = secrets.encrypt || ((s) => s);
    this.decrypt = secrets.decrypt || ((s) => s);
    this.defaults = mergeDefaults(DEFAULT_SETTINGS, defaults);
    if (Array.isArray(defaults.assistants)) this.defaults.assistants = defaults.assistants;
    this.index = [];
    this._queue = Promise.resolve();
    this._listeners = new Set();
  }

  // Called after the user changes chats or shared settings (not for changes
  // that came in through sync). Used to schedule a sync.
  onChange(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  _changed(what) {
    for (const cb of this._listeners) {
      try {
        cb(what);
      } catch {
        // a listener must never break saving
      }
    }
  }

  // Run mutations one at a time so concurrent saves never clobber index.json.
  _serial(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  async _readJson(name, fallback) {
    try {
      const text = await this.backend.read(name);
      return text == null ? fallback : JSON.parse(text);
    } catch {
      return fallback;
    }
  }

  _writeJson(name, data) {
    return this.backend.write(name, JSON.stringify(data, null, 2));
  }

  _chatFile(id) {
    if (!ID_RE.test(String(id))) throw new Error('Invalid chat id');
    return `chats/${id}.json`;
  }

  _meta(chat) {
    const last = [...(chat.messages || [])].reverse().find((m) => m.content);
    return {
      id: chat.id,
      title: chat.title || 'New chat',
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      modifiedAt: chat.modifiedAt || chat.updatedAt || 1,
      rev: chat.rev || `m${chat.modifiedAt || chat.updatedAt || 1}`,
      pinned: !!chat.pinned,
      assistantId: chat.assistantId || null,
      model: chat.model || null,
      messageCount: (chat.messages || []).length,
      preview: last ? previewText(last.content) : ''
    };
  }

  async _loadIndex() {
    const saved = await this._readJson('index.json', null);
    if (saved && Array.isArray(saved.chats)) {
      for (const c of saved.chats) {
        c.modifiedAt = c.modifiedAt || c.updatedAt || 1;
        c.rev = c.rev || `m${c.modifiedAt}`;
      }
      return saved.chats;
    }
    return this.rebuildIndex();
  }

  _saveIndex() {
    return this._writeJson('index.json', { version: 1, chats: this.index });
  }

  async rebuildIndex() {
    const chats = [];
    for (const f of await this.backend.list('chats')) {
      if (!f.endsWith('.json')) continue;
      const chat = upgradeChat(await this._readJson(`chats/${f}`, null));
      if (chat && chat.id) chats.push(this._meta(chat));
    }
    this.index = chats;
    await this._saveIndex();
    return chats;
  }

  // ---- chats -----------------------------------------------------------

  async listChats() {
    return [...this.index].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  async getChat(id) {
    return upgradeChat(await this._readJson(this._chatFile(id), null));
  }

  createChat(init = {}) {
    const now = Date.now();
    return this.saveChat({
      id: newId(),
      title: init.title || 'New chat',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      assistantId: init.assistantId || null,
      model: init.model || null,
      systemPrompt: init.systemPrompt || '',
      messages: []
    });
  }

  saveChat(chat) {
    return this._putChat(chat, { local: true });
  }

  // Store a chat that arrived through sync, keeping its modifiedAt.
  putSyncedChat(chat) {
    return this._putChat(chat, { local: false });
  }

  _putChat(chat, { local }) {
    if (!chat || !chat.id) return Promise.reject(new Error('Chat must have an id'));
    let file;
    try {
      file = this._chatFile(chat.id);
    } catch (err) {
      return Promise.reject(err);
    }
    upgradeChat(chat);
    const run = this._serial(async () => {
      chat.updatedAt = chat.updatedAt || Date.now();
      chat.createdAt = chat.createdAt || chat.updatedAt;
      if (local || !chat.modifiedAt) chat.modifiedAt = Math.max(Date.now(), (chat.modifiedAt || 0) + 1);
      // Every local save gets a new revision id, so sync can tell versions
      // apart even when two devices save in the same millisecond.
      if (local) chat.rev = newId();
      else chat.rev = chat.rev || `m${chat.modifiedAt}`;
      await this._writeJson(file, chat);
      const meta = this._meta(chat);
      const i = this.index.findIndex((c) => c.id === chat.id);
      if (i >= 0) this.index[i] = meta;
      else this.index.push(meta);
      await this._saveIndex();
      if (!local) await this._dropTombstones([chat.id]);
      return chat;
    });
    if (local) run.then(() => this._changed('chat'), () => {});
    return run;
  }

  deleteChat(id) {
    return this._removeChat(id, { local: true });
  }

  // Delete a chat because it was deleted on another device.
  deleteSyncedChat(id) {
    return this._removeChat(id, { local: false });
  }

  _removeChat(id, { local }) {
    let file;
    try {
      file = this._chatFile(id);
    } catch (err) {
      return Promise.reject(err);
    }
    const run = this._serial(async () => {
      await this.backend.remove(file);
      this.index = this.index.filter((c) => c.id !== id);
      await this._saveIndex();
      // Remember the deletion so sync can remove the chat on other devices.
      if (local) await this._writeJson('deleted.json', { ...(await this.getTombstones()), [id]: Date.now() });
      return true;
    });
    if (local) run.then(() => this._changed('chat'), () => {});
    return run;
  }

  getTombstones() {
    return this._readJson('deleted.json', {});
  }

  // Forget deletions once every device can see them.
  clearTombstones(ids) {
    return this._serial(() => this._dropTombstones(ids));
  }

  async _dropTombstones(ids) {
    const tomb = await this.getTombstones();
    if (!ids.some((id) => id in tomb)) return;
    for (const id of ids) delete tomb[id];
    await this._writeJson('deleted.json', tomb);
  }

  // Finds the parts of earlier chats that best match `query`, for giving the
  // model context from past conversations. Scores each message by the rare
  // words it shares with the query; chats are read once and cached.
  //   -> [{ chatId, title, updatedAt, role, text }]
  async recall(query, { excludeId = null, limit = 3, maxChars = 1500 } = {}) {
    const want = [...new Set(terms(query))];
    if (!want.length) return [];
    if (!this._recallCache) this._recallCache = new Map();
    const docs = [];
    for (const meta of [...this.index].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 500)) {
      if (meta.id === excludeId) continue;
      let entry = this._recallCache.get(meta.id);
      if (!entry || entry.rev !== meta.rev) {
        const chat = await this.getChat(meta.id).catch(() => null);
        if (!chat) continue;
        entry = {
          rev: meta.rev,
          title: chat.title || 'Chat',
          updatedAt: chat.updatedAt || 0,
          messages: (chat.messages || [])
            .filter((m) => m.content && !m.error)
            .map((m) => ({ role: m.role, text: m.content, words: new Set(terms(m.content)) }))
        };
        this._recallCache.set(meta.id, entry);
      }
      for (const m of entry.messages) docs.push({ chatId: meta.id, entry, m });
    }
    if (!docs.length) return [];

    // Inverse document frequency: rare words count more.
    const df = new Map(want.map((w) => [w, 0]));
    for (const d of docs) for (const w of want) if (d.m.words.has(w)) df.set(w, df.get(w) + 1);
    const idf = (w) => Math.log(1 + docs.length / (1 + df.get(w)));
    const needed = Math.min(2, want.length);
    const scored = [];
    for (const d of docs) {
      const hits = want.filter((w) => d.m.words.has(w));
      if (hits.length < needed) continue;
      scored.push({ d, hits, score: hits.reduce((sum, w) => sum + idf(w), 0) });
    }
    scored.sort((a, b) => b.score - a.score);

    // Best message per chat, then fit the budget.
    const out = [];
    const used = new Set();
    let budget = maxChars;
    const per = Math.max(120, Math.floor(maxChars / limit));
    for (const { d, hits } of scored) {
      if (out.length >= limit || budget < 80) break;
      if (used.has(d.chatId)) continue;
      used.add(d.chatId);
      const text = excerpt(d.m.text, hits, Math.min(per, budget));
      budget -= text.length;
      out.push({ chatId: d.chatId, title: d.entry.title, updatedAt: d.entry.updatedAt, role: d.m.role, text });
    }
    return out;
  }

  // Full-text search over titles and message contents.
  async searchChats(query) {
    const q = String(query || '').trim().toLowerCase();
    const all = await this.listChats();
    if (!q) return all;
    const hits = [];
    for (const meta of all) {
      if (meta.title.toLowerCase().includes(q)) {
        hits.push(meta);
        continue;
      }
      const chat = await this.getChat(meta.id);
      const msg = chat && chat.messages.find((m) => String(m.content || '').toLowerCase().includes(q));
      if (msg) {
        const text = String(msg.content);
        const at = text.toLowerCase().indexOf(q);
        const start = Math.max(0, at - 40);
        hits.push({ ...meta, preview: (start > 0 ? '…' : '') + text.slice(start, start + 140) });
      }
    }
    return hits;
  }

  // ---- backup ----------------------------------------------------------

  async exportAll() {
    const chats = [];
    for (const m of this.index) {
      const chat = await this.getChat(m.id);
      if (chat) chats.push(chat);
    }
    return { app: 'balimda', version: 1, exportedAt: new Date().toISOString(), chats };
  }

  async importAll(data) {
    const chats = Array.isArray(data) ? data : data && data.chats;
    if (!Array.isArray(chats)) throw new Error('This is not a Balimda backup file');
    let imported = 0;
    for (const chat of chats) {
      if (!chat || !Array.isArray(chat.messages)) continue;
      if (!chat.id || !ID_RE.test(chat.id)) chat.id = newId();
      await this.saveChat(chat);
      imported++;
    }
    return imported;
  }

  // ---- settings & state ------------------------------------------------

  async getSettings() {
    const saved = await this._readJson('settings.json', {});
    if (Array.isArray(saved.pals) && !Array.isArray(saved.assistants)) saved.assistants = saved.pals;
    delete saved.pals;
    const settings = mergeDefaults(this.defaults, saved);
    // Keep the user's own assistant list rather than merging it with defaults.
    if (Array.isArray(saved.assistants)) settings.assistants = saved.assistants;
    for (const p of Object.values(settings.providers)) {
      if (p.apiKey) p.apiKey = this.decrypt(p.apiKey);
    }
    return settings;
  }

  async saveSettings(settings) {
    const copy = structuredClone(settings);
    for (const p of Object.values(copy.providers || {})) {
      if (p.apiKey) p.apiKey = this.encrypt(p.apiKey);
    }
    let sharedChanged = false;
    await this._serial(async () => {
      const before = await this.getSettings();
      // The app window may hold an older list of computers; keep the saved one.
      copy.computers = before.computers;
      sharedChanged = JSON.stringify(pickShared(before)) !== JSON.stringify(pickShared({ ...settings, computers: before.computers }));
      copy.sharedModifiedAt = sharedChanged ? Date.now() : before.sharedModifiedAt || 0;
      await this._writeJson('settings.json', copy);
    });
    if (sharedChanged) this._changed('settings');
    return this.getSettings();
  }

  // The settings that sync between devices, and when they last changed.
  async getSharedSettings() {
    const settings = await this.getSettings();
    return { modifiedAt: settings.sharedModifiedAt || 0, data: pickShared(settings) };
  }

  applySharedSettings(data, modifiedAt) {
    return this._serial(async () => {
      const saved = await this._readJson('settings.json', {});
      for (const k of SHARED_SETTINGS) if (k in data) saved[k] = data[k];
      saved.sharedModifiedAt = modifiedAt;
      delete saved.pals;
      await this._writeJson('settings.json', saved);
    });
  }

  // A computer announces (or stops) sharing its models with the phone.
  // Returns whether anything changed.
  async publishComputer(id, info) {
    let changed = false;
    await this._serial(async () => {
      const saved = await this._readJson('settings.json', {});
      const computers = { ...(saved.computers || {}) };
      const { updatedAt: _a, ...before } = computers[id] || {};
      const { updatedAt: _b, ...after } = info;
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      computers[id] = { ...info, updatedAt: Date.now() };
      saved.computers = computers;
      saved.sharedModifiedAt = Date.now();
      await this._writeJson('settings.json', saved);
      changed = true;
    });
    if (changed) this._changed('settings');
    return changed;
  }

  // Small JSON files owned by other modules (sync config and state).
  readFile(name, fallback = null) {
    return this._readJson(name, fallback);
  }

  writeFile(name, data) {
    return this._serial(() => (data == null ? this.backend.remove(name) : this._writeJson(name, data)));
  }

  getState() {
    return this._readJson('state.json', {});
  }

  saveState(patch) {
    return this._serial(async () => {
      const state = { ...(await this.getState()), ...patch };
      await this._writeJson('state.json', state);
      return state;
    });
  }
}

module.exports = { Storage, DEFAULT_SETTINGS, SHARED_SETTINGS, mergeDefaults, previewText };
