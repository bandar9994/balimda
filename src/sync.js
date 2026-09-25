// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Sync between devices through a private GitHub repository the user owns.
//
// Everything is encrypted on the device before it leaves (AES-256-GCM with a
// key made from the user's passphrase), so the repository only ever holds
// unreadable data. Layout of the repository:
//
//   balimda-sync.json   format, key-derivation salt and a passphrase check
//   index.enc           encrypted list of chats: id -> { m: modifiedAt, d: deleted }
//   chats/<id>.enc      one encrypted chat per file
//   shared.enc          encrypted shared settings (assistants, memory)
//
// Each sync is one Git commit, so changes from two devices can never
// half-overwrite each other: if another device pushed first, we pull its
// changes and try again. The same code runs on desktop (Node) and on phones
// (web view); it only needs fetch and WebCrypto.

'use strict';

const FORMAT = 1;
const META_FILE = 'balimda-sync.json';
const INDEX_FILE = 'index.enc';
const SHARED_FILE = 'shared.enc';
const CHECK_TEXT = 'balimda-sync-check';
const KDF_ITERATIONS = 310000;
const CONFIG_FILE = 'sync.json';
const STATE_FILE = 'sync-state.json';
const TREE_CHUNK_BYTES = 4 * 1024 * 1024;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

class SyncError extends Error {}

// ---- bytes, compression and encryption ---------------------------------------

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(String(text).replace(/\s+/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function transform(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

const subtle = () => globalThis.crypto.subtle;

async function deriveKeyBytes(passphrase, salt, iterations) {
  const base = await subtle().importKey('raw', utf8.encode(String(passphrase).normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
  return new Uint8Array(bits);
}

function importKey(raw) {
  return subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// JSON -> gzip -> AES-GCM -> base64 text (stored as a text file in the repo).
async function seal(key, value) {
  const packed = await transform(utf8.encode(JSON.stringify(value)), new CompressionStream('gzip'));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, packed));
  const out = new Uint8Array(1 + iv.length + ct.length);
  out[0] = FORMAT;
  out.set(iv, 1);
  out.set(ct, 1 + iv.length);
  return toBase64(out);
}

async function unseal(key, text) {
  const bytes = fromBase64(text);
  if (bytes[0] !== FORMAT) throw new SyncError('The synced data was made by a newer version of Balimda. Update the app on this device.');
  let plain;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: bytes.subarray(1, 13) }, key, bytes.subarray(13));
  } catch {
    throw new SyncError('Could not decrypt the synced data. Use the same sync passphrase on every device.');
  }
  return JSON.parse(fromUtf8.decode(await transform(new Uint8Array(plain), new DecompressionStream('gzip'))));
}

// ---- GitHub ------------------------------------------------------------------

function parseRepo(input) {
  const m = String(input || '').trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  if (!m) throw new SyncError('Enter the repository as owner/name, for example bandar9994/balimda-sync.');
  return `${m[1]}/${m[2]}`;
}

function githubError(status, data) {
  const msg = (data && data.message) || '';
  if (status === 401) return 'GitHub did not accept the access token. Check that it is correct and has not expired.';
  if (status === 404) return 'Repository not found. Check the name, and that the token was given access to it.';
  if (status === 403 && /rate limit/i.test(msg)) return 'GitHub rate limit reached. Sync will try again in a few minutes.';
  if (status === 403) return 'The access token cannot write to this repository. Give it "Contents: Read and write" permission.';
  return `GitHub error ${status}${msg ? `: ${msg}` : ''}`;
}

class GitHub {
  constructor({ repo, token, fetch }) {
    this.repo = repo;
    this.token = token;
    this.fetch = fetch || ((...args) => globalThis.fetch(...args));
  }

  async req(method, path, body) {
    let res;
    try {
      res = await this.fetch(`https://api.github.com/repos/${this.repo}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (err) {
      const e = new SyncError(`Can't reach GitHub (${err.message || err}). Sync will try again when you're online.`);
      e.offline = true;
      throw e;
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const err = new SyncError(githubError(res.status, data));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  info() {
    return this.req('GET', '');
  }

  // Latest commit on the branch, or null for an empty repository. The time
  // stamp stops web views from answering from their HTTP cache.
  async head(branch) {
    try {
      const ref = await this.req('GET', `/git/ref/heads/${encodeURIComponent(branch)}?t=${Date.now()}`);
      return ref.object.sha;
    } catch (err) {
      if (err.status === 409 || err.status === 404) return null;
      throw err;
    }
  }

  async files(commitSha) {
    const commit = await this.req('GET', `/git/commits/${commitSha}`);
    const tree = await this.req('GET', `/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new SyncError('The sync repository has too many files.');
    const files = new Map();
    for (const e of tree.tree) if (e.type === 'blob') files.set(e.path, e.sha);
    return { tree: commit.tree.sha, files };
  }

  async text(blobSha) {
    const blob = await this.req('GET', `/git/blobs/${blobSha}`);
    return fromUtf8.decode(fromBase64(blob.content));
  }

  // Creates the first commit in an empty repository.
  async init(branch) {
    const readme = '# Balimda sync\n\nEncrypted chat sync data for the Balimda app. The files are encrypted on the device and cannot be read without the sync passphrase. Do not edit them.\n';
    const r = await this.req('PUT', '/contents/README.md', {
      message: 'Set up Balimda sync',
      content: toBase64(utf8.encode(readme)),
      branch
    });
    return r.commit.sha;
  }

  // One commit with all changes. `writes` are { path, text }, `deletes` are
  // paths that exist in the parent. Contents go inline in the tree request,
  // which keeps a sync to a handful of API calls however many chats changed.
  async commit({ branch, parent, baseTree, writes, deletes, message }) {
    let tree = baseTree;
    let batch = deletes.map((path) => ({ path, mode: '100644', type: 'blob', sha: null }));
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      tree = (await this.req('POST', '/git/trees', { base_tree: tree, tree: batch })).sha;
      batch = [];
      size = 0;
    };
    for (const w of writes) {
      batch.push({ path: w.path, mode: '100644', type: 'blob', content: w.text });
      size += w.text.length;
      if (size > TREE_CHUNK_BYTES) await flush();
    }
    await flush();
    const commit = await this.req('POST', '/git/commits', { message, tree, parents: [parent] });
    try {
      await this.req('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
    } catch (err) {
      if (err.status === 422 || err.status === 409) {
        const e = new SyncError('Another device synced at the same time.');
        e.conflict = true;
        throw e;
      }
      throw err;
    }
    return commit.sha;
  }
}

// ---- merging -------------------------------------------------------------------

const msgKey = (m) => m.id || `${m.role}|${m.createdAt}|${String(m.content || '').slice(0, 80)}`;

// The same chat changed on two devices before they synced: keep the newer
// version and add any messages only the other one has, so nothing is lost.
function mergeChats(a, b) {
  const [newer, older] = (a.modifiedAt || 0) >= (b.modifiedAt || 0) ? [a, b] : [b, a];
  const seen = new Set(newer.messages.map(msgKey));
  const extra = older.messages.filter((m) => !seen.has(msgKey(m)));
  const merged = structuredClone(newer);
  if (extra.length) {
    merged.messages = [...merged.messages, ...structuredClone(extra)]
      .map((m, i) => [m, i])
      .sort(([x, i], [y, j]) => (x.createdAt || 0) - (y.createdAt || 0) || i - j)
      .map(([m]) => m);
  }
  merged.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
  return merged;
}

async function pool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

// ---- sync ----------------------------------------------------------------------

class Sync {
  /**
   * @param storage   Storage instance
   * @param device    short device name used in commit messages
   * @param secrets   { encrypt, decrypt } for the token and key at rest
   * @param fetch     fetch implementation (desktop passes Electron's)
   * @param onEvent   receives { type: 'status', status } and
   *                  { type: 'changed', chats, deleted, settings }
   * @param auto      sync by itself a few seconds after local changes
   */
  constructor({ storage, device = 'device', secrets = {}, fetch, onEvent = () => {}, auto = true }) {
    this.auto = auto;
    this.storage = storage;
    this.device = device;
    this.encrypt = secrets.encrypt || ((s) => s);
    this.decrypt = secrets.decrypt || ((s) => s);
    this.fetch = fetch;
    this.onEvent = onEvent;
    this.config = null;
    this.state = {};
    this.running = null;
    this.again = false;
    this.timer = null;
    this.lastPush = 0;
  }

  async load() {
    const cfg = await this.storage.readFile(CONFIG_FILE, null);
    this.config = cfg && cfg.repo ? { ...cfg, token: this.decrypt(cfg.token), key: this.decrypt(cfg.key) } : null;
    this.state = (await this.storage.readFile(STATE_FILE, null)) || {};
    if (this.auto) this.storage.onChange(() => this.soon());
    return this.status();
  }

  status() {
    return {
      configured: !!this.config,
      repo: this.config ? this.config.repo : null,
      running: !!this.running,
      lastSync: this.state.lastSync || null,
      error: this.state.error || null,
      offline: !!this.state.offline
    };
  }

  _emitStatus() {
    this.onEvent({ type: 'status', status: this.status() });
  }

  _github(cfg = this.config) {
    return new GitHub({ repo: cfg.repo, token: cfg.token, fetch: this.fetch });
  }

  // Set up sync with a repository. The first device creates the encryption
  // settings; later devices must use the same passphrase.
  async connect({ repo, token, passphrase }) {
    repo = parseRepo(repo);
    token = String(token || '').trim();
    if (!token) throw new SyncError('Enter a GitHub access token.');
    if (String(passphrase || '').length < 8) throw new SyncError('Use a sync passphrase of at least 8 characters.');
    const gh = new GitHub({ repo, token, fetch: this.fetch });
    const info = await gh.info();
    if (!info.private) throw new SyncError('This repository is public. Use a private repository for your chats.');
    const branch = info.default_branch || 'main';

    let head = await gh.head(branch);
    const { tree, files } = head ? await gh.files(head) : { tree: null, files: new Map() };
    let keyBytes;
    if (files.has(META_FILE)) {
      const meta = JSON.parse(await gh.text(files.get(META_FILE)));
      if (meta.app !== 'balimda' || meta.format > FORMAT) throw new SyncError('This repository has sync data from a newer version of Balimda. Update the app.');
      keyBytes = await deriveKeyBytes(passphrase, fromBase64(meta.salt), meta.iterations);
      const check = await unseal(await importKey(keyBytes), meta.check).catch(() => null);
      if (check !== CHECK_TEXT) throw new SyncError('Wrong sync passphrase. Use the same passphrase you chose on your first device.');
    } else {
      const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
      keyBytes = await deriveKeyBytes(passphrase, salt, KDF_ITERATIONS);
      const meta = {
        app: 'balimda',
        format: FORMAT,
        cipher: 'AES-256-GCM',
        kdf: 'PBKDF2-SHA256',
        iterations: KDF_ITERATIONS,
        salt: toBase64(salt),
        check: await seal(await importKey(keyBytes), CHECK_TEXT)
      };
      let baseTree = tree;
      if (!head) {
        head = await gh.init(branch);
        baseTree = (await gh.files(head)).tree;
      }
      await gh.commit({
        branch,
        parent: head,
        baseTree,
        writes: [{ path: META_FILE, text: `${JSON.stringify(meta, null, 2)}\n` }],
        deletes: [],
        message: 'Set up Balimda sync (encrypted)'
      });
    }

    this.config = { repo, branch, token, key: toBase64(keyBytes) };
    await this.storage.writeFile(CONFIG_FILE, {
      repo,
      branch,
      token: this.encrypt(token),
      key: this.encrypt(this.config.key)
    });
    // A fresh start: every chat is compared with the repository once.
    this.state = {};
    await this.storage.writeFile(STATE_FILE, this.state);
    await this.run();
    return this.status();
  }

  async disconnect() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.running) await this.running.catch(() => {});
    this.config = null;
    this.state = {};
    await this.storage.writeFile(CONFIG_FILE, null);
    await this.storage.writeFile(STATE_FILE, null);
    this._emitStatus();
    return this.status();
  }

  // Sync a few seconds after a change, and not more than every 20 seconds, so
  // a streaming reply turns into one commit instead of dozens.
  soon() {
    if (!this.config) return;
    clearTimeout(this.timer);
    const wait = Math.max(4000, this.lastPush + 20000 - Date.now());
    this.timer = setTimeout(() => this.run(), wait);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  // True when this device has changes the repository doesn't have yet.
  hasLocalChanges() {
    const base = this.state.chats || {};
    for (const c of this.storage.index) if ((c.modifiedAt || 0) !== base[c.id]) return true;
    return false;
  }

  // Local changes that haven't reached the repository yet.
  pending() {
    return !!this.config && (!!this.running || !!this.timer || this.hasLocalChanges());
  }

  run() {
    if (!this.config) return Promise.resolve(this.status());
    clearTimeout(this.timer);
    this.timer = null;
    if (this.running) {
      this.again = true;
      return this.running.then(() => this.status());
    }
    this.running = (async () => {
      this._emitStatus();
      do {
        this.again = false;
        await this._runWithRetry();
      } while (this.again && this.config);
    })().finally(() => {
      this.running = null;
      this._emitStatus();
    });
    return this.running.then(() => this.status());
  }

  async _runWithRetry() {
    for (let attempt = 0; ; attempt++) {
      try {
        await this._syncOnce();
        this.state.error = null;
        this.state.offline = false;
        break;
      } catch (err) {
        if (err.conflict && attempt < 4) continue;
        this.state.error = err.message || String(err);
        this.state.offline = !!err.offline;
        break;
      }
    }
    if (this.config) await this.storage.writeFile(STATE_FILE, this.state).catch(() => {});
  }

  async _syncOnce() {
    const cfg = this.config;
    const gh = this._github(cfg);
    const key = await importKey(fromBase64(cfg.key));
    const storage = this.storage;

    const head = await gh.head(cfg.branch);
    if (!head) throw new SyncError('The sync repository is empty. Connect again to set it up.');
    const tomb = await storage.getTombstones();
    const shared = await storage.getSharedSettings();
    if (head === this.state.head && !this.hasLocalChanges() && !Object.keys(tomb).length && shared.modifiedAt === this.state.shared) {
      this.state.lastSync = Date.now();
      return;
    }

    const { tree, files } = await gh.files(head);
    if (!files.has(META_FILE)) throw new SyncError('The sync repository was reset. Connect again to set it up.');
    const remote = files.has(INDEX_FILE) ? await unseal(key, await gh.text(files.get(INDEX_FILE))) : { chats: {} };
    remote.chats = remote.chats || {};
    const next = { chats: { ...remote.chats }, shared: remote.shared || null };
    const base = this.state.chats || {};
    const local = new Map(storage.index.map((c) => [c.id, c.modifiedAt || 0]));
    const chatPath = (id) => `chats/${id}.enc`;
    const fetchChat = async (id) => (files.has(chatPath(id)) ? unseal(key, await gh.text(files.get(chatPath(id)))) : null);

    const pulls = [];
    const pushes = [];
    const merges = [];
    const localDeletes = [];
    const remoteDeletes = [];
    for (const id of new Set([...local.keys(), ...Object.keys(remote.chats), ...Object.keys(tomb)])) {
      const r = remote.chats[id];
      const lm = local.get(id);
      if (lm != null) {
        if (!r) pushes.push(id);
        else if (r.d) (lm > r.m ? pushes : localDeletes).push(id);
        else if (r.m === lm) continue;
        else if (lm > (base[id] || 0) && r.m > (base[id] || 0)) merges.push(id);
        else (r.m > lm ? pulls : pushes).push(id);
      } else if (r && !r.d) {
        if (tomb[id] != null && tomb[id] >= r.m) remoteDeletes.push(id);
        else pulls.push(id);
      }
    }

    const changed = [];
    const deleted = [];
    await pool(pulls, 6, async (id) => {
      const chat = await fetchChat(id);
      if (!chat) return;
      chat.modifiedAt = remote.chats[id].m;
      await storage.putSyncedChat(chat);
      changed.push(id);
    });
    await pool(merges, 6, async (id) => {
      const theirs = await fetchChat(id);
      const mine = await storage.getChat(id);
      if (!mine) return;
      if (!theirs) {
        pushes.push(id);
        return;
      }
      theirs.modifiedAt = remote.chats[id].m;
      const merged = mergeChats(mine, theirs);
      merged.modifiedAt = Math.max(Date.now(), mine.modifiedAt + 1, theirs.modifiedAt + 1);
      await storage.putSyncedChat(merged);
      changed.push(id);
      pushes.push(id);
    });
    for (const id of localDeletes) {
      await storage.deleteSyncedChat(id);
      deleted.push(id);
    }

    const writes = [];
    const deletes = [];
    for (const id of pushes) {
      const chat = await storage.getChat(id);
      if (!chat) continue;
      // Chats saved before sync existed have no modifiedAt yet.
      chat.modifiedAt = chat.modifiedAt || chat.updatedAt || local.get(id) || 1;
      writes.push({ path: chatPath(id), text: await seal(key, chat) });
      next.chats[id] = { m: chat.modifiedAt };
    }
    for (const id of remoteDeletes) {
      next.chats[id] = { m: Math.max(tomb[id], remote.chats[id].m), d: true };
      if (files.has(chatPath(id))) deletes.push(chatPath(id));
    }

    // Shared settings: newest wins.
    let settingsChanged = false;
    const rs = remote.shared;
    if (rs && rs.m > shared.modifiedAt && files.has(SHARED_FILE)) {
      await storage.applySharedSettings(await unseal(key, await gh.text(files.get(SHARED_FILE))), rs.m);
      settingsChanged = true;
    } else if (!rs || shared.modifiedAt > rs.m) {
      writes.push({ path: SHARED_FILE, text: await seal(key, shared.data) });
      next.shared = { m: shared.modifiedAt };
    }

    let newHead = head;
    if (writes.length || deletes.length) {
      writes.push({ path: INDEX_FILE, text: await seal(key, next) });
      newHead = await gh.commit({
        branch: cfg.branch,
        parent: head,
        baseTree: tree,
        writes,
        deletes,
        message: `Sync from ${this.device}`
      });
      this.lastPush = Date.now();
    }

    // Everything on this device now matches the repository.
    const nextBase = {};
    for (const c of storage.index) nextBase[c.id] = c.modifiedAt || 0;
    this.state = {
      ...this.state,
      head: newHead,
      chats: nextBase,
      shared: (await storage.getSharedSettings()).modifiedAt,
      lastSync: Date.now()
    };
    const handled = Object.keys(tomb).filter((id) => !local.has(id));
    if (handled.length) await storage.clearTombstones(handled);

    if (changed.length || deleted.length || settingsChanged) {
      this.onEvent({ type: 'changed', chats: changed, deleted, settings: settingsChanged });
    }
  }
}

module.exports = { Sync, SyncError, GitHub, mergeChats, parseRepo, seal, unseal, importKey, deriveKeyBytes };
