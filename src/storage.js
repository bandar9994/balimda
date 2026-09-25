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
  memory: '',
  providers: {
    ollama: { enabled: true, baseUrl: 'http://127.0.0.1:11434' },
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
      pinned: !!chat.pinned,
      assistantId: chat.assistantId || null,
      model: chat.model || null,
      messageCount: (chat.messages || []).length,
      preview: last ? previewText(last.content) : ''
    };
  }

  async _loadIndex() {
    const saved = await this._readJson('index.json', null);
    if (saved && Array.isArray(saved.chats)) return saved.chats;
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
    if (!chat || !chat.id) return Promise.reject(new Error('Chat must have an id'));
    let file;
    try {
      file = this._chatFile(chat.id);
    } catch (err) {
      return Promise.reject(err);
    }
    upgradeChat(chat);
    return this._serial(async () => {
      chat.updatedAt = chat.updatedAt || Date.now();
      chat.createdAt = chat.createdAt || chat.updatedAt;
      await this._writeJson(file, chat);
      const meta = this._meta(chat);
      const i = this.index.findIndex((c) => c.id === chat.id);
      if (i >= 0) this.index[i] = meta;
      else this.index.push(meta);
      await this._saveIndex();
      return chat;
    });
  }

  deleteChat(id) {
    let file;
    try {
      file = this._chatFile(id);
    } catch (err) {
      return Promise.reject(err);
    }
    return this._serial(async () => {
      await this.backend.remove(file);
      this.index = this.index.filter((c) => c.id !== id);
      await this._saveIndex();
      return true;
    });
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
    await this._serial(() => this._writeJson('settings.json', copy));
    return this.getSettings();
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

module.exports = { Storage, DEFAULT_SETTINGS, mergeDefaults, previewText };
