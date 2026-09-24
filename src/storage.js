// Persistent on-disk storage for chats, settings and app state.
// Everything lives as plain JSON under one data directory so it is easy to
// back up, sync or inspect by hand.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  pals: [
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

function newId() {
  return crypto.randomUUID();
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
   * @param {string} dir  data directory
   * @param {{encrypt?: (s: string) => string, decrypt?: (s: string) => string}} [secrets]
   */
  constructor(dir, secrets = {}) {
    this.dir = dir;
    this.chatsDir = path.join(dir, 'chats');
    this.encrypt = secrets.encrypt || ((s) => s);
    this.decrypt = secrets.decrypt || ((s) => s);
    fs.mkdirSync(this.chatsDir, { recursive: true });
    this.index = this._loadIndex();
  }

  // ---- low level -------------------------------------------------------

  _readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  // Write to a temp file then rename, so a crash never leaves a half-written file.
  _writeJson(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  _chatFile(id) {
    if (!/^[A-Za-z0-9-]+$/.test(String(id))) throw new Error('Invalid chat id');
    return path.join(this.chatsDir, `${id}.json`);
  }

  _meta(chat) {
    const last = [...(chat.messages || [])].reverse().find((m) => m.content);
    return {
      id: chat.id,
      title: chat.title || 'New chat',
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      pinned: !!chat.pinned,
      palId: chat.palId || null,
      model: chat.model || null,
      messageCount: (chat.messages || []).length,
      preview: last ? previewText(last.content) : ''
    };
  }

  _loadIndex() {
    const indexFile = path.join(this.dir, 'index.json');
    const saved = this._readJson(indexFile, null);
    if (saved && Array.isArray(saved.chats)) return saved.chats;
    return this.rebuildIndex();
  }

  _saveIndex() {
    this._writeJson(path.join(this.dir, 'index.json'), { version: 1, chats: this.index });
  }

  rebuildIndex() {
    const chats = [];
    for (const f of fs.readdirSync(this.chatsDir)) {
      if (!f.endsWith('.json')) continue;
      const chat = this._readJson(path.join(this.chatsDir, f), null);
      if (chat && chat.id) chats.push(this._meta(chat));
    }
    this.index = chats;
    this._saveIndex();
    return chats;
  }

  // ---- chats -----------------------------------------------------------

  listChats() {
    return [...this.index].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  getChat(id) {
    return this._readJson(this._chatFile(id), null);
  }

  createChat(init = {}) {
    const now = Date.now();
    const chat = {
      id: newId(),
      title: init.title || 'New chat',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      palId: init.palId || null,
      model: init.model || null,
      systemPrompt: init.systemPrompt || '',
      messages: []
    };
    return this.saveChat(chat);
  }

  saveChat(chat) {
    if (!chat || !chat.id) throw new Error('Chat must have an id');
    chat.updatedAt = chat.updatedAt || Date.now();
    chat.createdAt = chat.createdAt || chat.updatedAt;
    this._writeJson(this._chatFile(chat.id), chat);
    const meta = this._meta(chat);
    const i = this.index.findIndex((c) => c.id === chat.id);
    if (i >= 0) this.index[i] = meta;
    else this.index.push(meta);
    this._saveIndex();
    return chat;
  }

  deleteChat(id) {
    try {
      fs.unlinkSync(this._chatFile(id));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    this.index = this.index.filter((c) => c.id !== id);
    this._saveIndex();
    return true;
  }

  // Full-text search over titles and message contents.
  searchChats(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return this.listChats();
    const hits = [];
    for (const meta of this.listChats()) {
      if (meta.title.toLowerCase().includes(q)) {
        hits.push(meta);
        continue;
      }
      const chat = this.getChat(meta.id);
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

  exportAll() {
    return {
      app: 'pal-desktop',
      version: 1,
      exportedAt: new Date().toISOString(),
      chats: this.index.map((m) => this.getChat(m.id)).filter(Boolean)
    };
  }

  importAll(data) {
    const chats = Array.isArray(data) ? data : data && data.chats;
    if (!Array.isArray(chats)) throw new Error('Not a Pal Desktop backup file');
    let imported = 0;
    for (const chat of chats) {
      if (!chat || !Array.isArray(chat.messages)) continue;
      if (!chat.id || !/^[A-Za-z0-9-]+$/.test(chat.id)) chat.id = newId();
      this.saveChat(chat);
      imported++;
    }
    return imported;
  }

  // ---- settings & state ------------------------------------------------

  getSettings() {
    const saved = this._readJson(path.join(this.dir, 'settings.json'), {});
    const settings = mergeDefaults(DEFAULT_SETTINGS, saved);
    // Keep the user's own pal list rather than merging it with defaults.
    if (Array.isArray(saved.pals)) settings.pals = saved.pals;
    for (const p of Object.values(settings.providers)) {
      if (p.apiKey) p.apiKey = this.decrypt(p.apiKey);
    }
    return settings;
  }

  saveSettings(settings) {
    const copy = structuredClone(settings);
    for (const p of Object.values(copy.providers || {})) {
      if (p.apiKey) p.apiKey = this.encrypt(p.apiKey);
    }
    this._writeJson(path.join(this.dir, 'settings.json'), copy);
    return this.getSettings();
  }

  getState() {
    return this._readJson(path.join(this.dir, 'state.json'), {});
  }

  saveState(patch) {
    const state = { ...this.getState(), ...patch };
    this._writeJson(path.join(this.dir, 'state.json'), state);
    return state;
  }
}

module.exports = { Storage, DEFAULT_SETTINGS, mergeDefaults };
