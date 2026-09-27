// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Sync between devices through storage the user owns: Google Drive's hidden
// app folder, or a private GitHub repository.
//
// Everything is encrypted on the device before it leaves (AES-256-GCM with a
// key made from the user's passphrase), so the storage only ever holds
// unreadable data. Files:
//
//   balimda-sync.json   format, key-derivation salt and a passphrase check
//   chats/<id>.enc      one encrypted chat per file
//   shared.enc          encrypted shared settings (assistants, memory)
//   index.enc           GitHub only: encrypted list of chats
//                       (id -> { m: modifiedAt, r: revision, d: deleted }); on Drive the
//                       same facts are kept on each file
//
// On GitHub each sync is one Git commit, so changes from two devices can
// never half-overwrite each other: if another device pushed first, we pull
// its changes and try again. The same code runs on desktop (Node) and on
// phones (web view); it only needs fetch and WebCrypto.

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

// The GitHub repository as a sync destination. The chat list lives in an
// encrypted index file, and every sync is one atomic commit.
class GitHubRemote {
  constructor({ repo, token, branch, fetch }) {
    this.gh = new GitHub({ repo, token, fetch });
    this.repo = repo;
    this.branch = branch;
    this.usesIndex = true;
  }

  static async open({ repo, token, fetch }) {
    const gh = new GitHub({ repo, token, fetch });
    const info = await gh.info();
    if (!info.private) throw new SyncError('This repository is public. Use a private repository for your chats.');
    return new GitHubRemote({ repo, token, branch: info.default_branch || 'main', fetch });
  }

  describe() {
    return { provider: 'github', label: `github.com/${this.repo}`, link: `https://github.com/${this.repo}` };
  }

  head() {
    return this.gh.head(this.branch);
  }

  async readMeta() {
    const head = await this.head();
    if (!head) return null;
    const { files } = await this.gh.files(head);
    return files.has(META_FILE) ? this.gh.text(files.get(META_FILE)) : null;
  }

  async createMeta(text) {
    let head = await this.head();
    if (!head) head = await this.gh.init(this.branch);
    const { tree } = await this.gh.files(head);
    try {
      await this.gh.commit({
        branch: this.branch,
        parent: head,
        baseTree: tree,
        writes: [{ path: META_FILE, text }],
        deletes: [],
        message: 'Set up Balimda sync (encrypted)'
      });
    } catch (err) {
      // Another device set it up at the same moment: use theirs.
      if (!err.conflict) throw err;
    }
    return this.readMeta();
  }

  async load() {
    const head = await this.head();
    if (!head) throw new SyncError('The sync repository is empty. Set up sync again.');
    const { tree, files } = await this.gh.files(head);
    if (!files.has(META_FILE)) throw new SyncError('The sync repository was reset. Set up sync again.');
    const read = (path) => (files.has(path) ? this.gh.text(files.get(path)) : Promise.resolve(null));
    return {
      head,
      tree,
      files,
      indexText: await read(INDEX_FILE),
      readChat: (id) => read(chatPath(id)),
      readShared: () => read(SHARED_FILE)
    };
  }

  async save(snap, { writes, deletes, shared, indexText, message }) {
    const out = writes.map((w) => ({ path: chatPath(w.id), text: w.text }));
    if (shared) out.push({ path: SHARED_FILE, text: shared.text });
    out.push({ path: INDEX_FILE, text: indexText });
    return this.gh.commit({
      branch: this.branch,
      parent: snap.head,
      baseTree: snap.tree,
      writes: out,
      deletes: deletes.map((d) => chatPath(d.id)).filter((p) => snap.files.has(p)),
      message
    });
  }
}

// ---- Google Drive ----------------------------------------------------------------

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

function driveError(status, data) {
  const reason = data && data.error && ((data.error.errors && data.error.errors[0] && data.error.errors[0].reason) || data.error.status);
  const msg = (data && data.error && data.error.message) || '';
  if (status === 401) return 'Google sign-in has expired. Open Settings → Sync and sign in again.';
  if (reason === 'storageQuotaExceeded') return 'Your Google Drive is full, so Balimda cannot save your chats there.';
  if (status === 429 || /rate ?limit/i.test(String(reason))) return 'Google Drive is busy. Sync will try again in a few minutes.';
  if (status === 403 && /disabled|has not been used/i.test(msg)) return 'The Google Drive API is not enabled for this app. See the setup guide.';
  return `Google Drive error ${status}${msg ? `: ${msg}` : ''}`;
}

// Google Drive's hidden app folder as a sync destination. Only Balimda can
// see this folder, and Balimda cannot see anything else in the user's Drive.
// Each chat is its own file; its modifiedAt and deleted flag are kept in the
// file's appProperties, so listing the folder is the chat index.
class DriveRemote {
  /**
   * @param token   async (force) => access token; force asks for a fresh one
   */
  constructor({ token, account, metaId, fetch }) {
    this.token = token;
    this.account = account || null;
    this.metaId = metaId || null;
    this.fetch = fetch || ((...args) => globalThis.fetch(...args));
    this.usesIndex = false;
  }

  describe() {
    return {
      provider: 'gdrive',
      label: this.account ? `Google Drive (${this.account})` : 'Google Drive',
      link: 'https://drive.google.com/drive/settings'
    };
  }

  async req(method, url, { body, contentType, text = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${await this.token(attempt > 0)}`,
            ...(contentType ? { 'Content-Type': contentType } : {})
          },
          body
        });
      } catch (err) {
        if (err instanceof SyncError) throw err;
        const e = new SyncError(`Can't reach Google Drive (${err.message || err}). Sync will try again when you're online.`);
        e.offline = true;
        throw e;
      }
      if (res.status === 401 && attempt === 0) continue;
      const raw = await res.text();
      if (!res.ok) {
        let data = null;
        try {
          data = JSON.parse(raw);
        } catch {
          // not JSON
        }
        const err = new SyncError(driveError(res.status, data));
        err.status = res.status;
        // A file another device just replaced: start the sync over.
        if (res.status === 404) err.conflict = true;
        throw err;
      }
      if (text) return raw;
      return raw ? JSON.parse(raw) : null;
    }
  }

  async email() {
    const r = await this.req('GET', `${DRIVE}/about?fields=user(emailAddress)`);
    return r && r.user ? r.user.emailAddress : null;
  }

  async list(q) {
    const files = [];
    let page = '';
    do {
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        pageSize: '1000',
        fields: 'nextPageToken,files(id,name,appProperties,createdTime,modifiedTime)'
      });
      if (q) params.set('q', q);
      if (page) params.set('pageToken', page);
      const r = await this.req('GET', `${DRIVE}/files?${params}`);
      files.push(...r.files);
      page = r.nextPageToken || '';
    } while (page);
    return files;
  }

  read(id) {
    return this.req('GET', `${DRIVE}/files/${id}?alt=media`, { text: true });
  }

  _multipart(meta, content) {
    const b = `balimda${Math.random().toString(36).slice(2)}`;
    return {
      contentType: `multipart/related; boundary=${b}`,
      body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${b}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${b}--`
    };
  }

  create(name, content, appProperties = {}) {
    return this.req('POST', `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`,
      this._multipart({ name, parents: ['appDataFolder'], mimeType: 'text/plain', appProperties }, content));
  }

  update(id, content, appProperties = {}) {
    return this.req('PATCH', `${DRIVE_UPLOAD}/files/${id}?uploadType=multipart&fields=id`,
      this._multipart({ appProperties }, content));
  }

  remove(id) {
    return this.req('DELETE', `${DRIVE}/files/${id}`, { text: true });
  }

  // The most recently changed file stands in for a commit id: if it hasn't
  // changed, nothing in the folder has.
  async head() {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      pageSize: '1',
      orderBy: 'modifiedTime desc',
      fields: 'files(id,modifiedTime)'
    });
    const r = await this.req('GET', `${DRIVE}/files?${params}`);
    const f = r.files[0];
    if (f) return `${f.id}@${f.modifiedTime}`;
    // Drive's file list can lag a few seconds behind new files, so an empty
    // list doesn't mean the data is gone. Ask for the setup file directly.
    return (await this._metaExists()) ? 'listing' : null;
  }

  // Whether our setup file (balimda-sync.json) still exists. Looked up by id,
  // which, unlike the file list, is always up to date.
  async _metaExists() {
    if (!this.metaId) {
      const [first] = await this._metaFiles();
      if (!first) return false;
      this.metaId = first.id;
    }
    try {
      const r = await this.req('GET', `${DRIVE}/files/${this.metaId}?fields=id,trashed`);
      return !r.trashed;
    } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }
  }

  async _metaFiles() {
    const files = await this.list(`name = '${META_FILE}'`);
    return files.sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
  }

  async readMeta() {
    const [first] = await this._metaFiles();
    if (!first) return null;
    this.metaId = first.id;
    return this.read(first.id);
  }

  async createMeta(text) {
    const mine = await this.create(META_FILE, text);
    this.metaId = mine.id;
    // If two devices set up at the same moment, the older file wins.
    const [first] = await this._metaFiles();
    if (first && first.id !== mine.id) {
      await this.remove(mine.id).catch(() => {});
      this.metaId = first.id;
      return this.read(first.id);
    }
    return text;
  }

  async load() {
    const head = await this.head();
    const byName = new Map();
    const extra = [];
    for (const f of await this.list()) {
      const m = Number((f.appProperties || {}).m) || 0;
      const prev = byName.get(f.name);
      if (!prev) byName.set(f.name, { ...f, m });
      else if (f.name !== META_FILE) {
        // Two devices created the same file at once: keep the newest.
        const keep = m > prev.m ? { ...f, m } : prev;
        extra.push(keep === prev ? f : prev);
        byName.set(f.name, keep);
      }
    }
    if (!byName.has(META_FILE) && !(await this._metaExists())) {
      throw new SyncError('The sync data in Google Drive was removed. Set up sync again.');
    }
    await pool(extra, 4, (f) => this.remove(f.id).catch(() => {}));

    const chats = {};
    for (const f of byName.values()) {
      const id = (f.name.match(/^chats\/(.+)\.enc$/) || [])[1];
      const props = f.appProperties || {};
      if (id) chats[id] = props.d === '1' ? { m: f.m, d: true } : { m: f.m, r: props.r };
    }
    const sharedFile = byName.get(SHARED_FILE);
    const read = (name) => (byName.has(name) ? this.read(byName.get(name).id) : Promise.resolve(null));
    return {
      head,
      files: byName,
      chats,
      shared: sharedFile ? { m: sharedFile.m } : null,
      readChat: (id) => (chats[id] && !chats[id].d ? read(chatPath(id)) : Promise.resolve(null)),
      readShared: () => read(SHARED_FILE)
    };
  }

  async save(snap, { writes, deletes, shared }) {
    const put = (name, content, props) => {
      const f = snap.files.get(name);
      return f ? this.update(f.id, content, props) : this.create(name, content, props);
    };
    await pool(writes, 4, (w) => put(chatPath(w.id), w.text, { m: String(w.m), r: w.rev, d: '0' }));
    // A deleted chat keeps an empty file marked deleted, so other devices
    // know to delete it too.
    await pool(deletes, 4, (d) => put(chatPath(d.id), '', { m: String(d.m), d: '1' }));
    if (shared) await put(SHARED_FILE, shared.text, { m: String(shared.m) });
    // Another device may have uploaded while we did, so the folder's state
    // now is not something this device has seen. Returning no head makes the
    // next sync compare everything again instead of assuming it's current.
    return null;
  }
}

const chatPath = (id) => `chats/${id}.enc`;

// ---- merging -------------------------------------------------------------------

const factKey = (line) => line.toLowerCase().replace(/^[-•*\s]+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Memory changed on two devices before they synced. Compare each side with
// the memory both last agreed on (base): keep the lines either side added,
// drop the lines either side removed. An updated fact is a removed line plus
// an added one, so updates carry over too.
function mergeMemory(base, mine, theirs) {
  const keys = (text) => new Set(String(text || '').split('\n').map(factKey).filter(Boolean));
  const was = keys(base);
  const mineKeys = keys(mine);
  const theirKeys = keys(theirs);
  const out = [];
  const seen = new Set();
  for (const line of String(mine || '').split('\n')) {
    const k = factKey(line);
    if (!k) {
      if (line.trim() === '' && out.length && out.at(-1).trim() !== '') out.push('');
      continue;
    }
    if (seen.has(k) || (was.has(k) && !theirKeys.has(k))) continue;
    seen.add(k);
    out.push(line);
  }
  for (const line of String(theirs || '').split('\n')) {
    const k = factKey(line);
    if (!k || seen.has(k) || mineKeys.has(k) || was.has(k)) continue;
    seen.add(k);
    out.push(line);
  }
  while (out.length && out.at(-1).trim() === '') out.pop();
  return out.join('\n');
}

// Shared settings changed on both devices: memory is merged line by line,
// the other settings come from whichever side changed last.
function mergeShared(base, mine, theirs) {
  const newer = mine.modifiedAt > theirs.modifiedAt ? mine.data : theirs.data;
  const merged = { ...newer, memory: mergeMemory(base, mine.data.memory, theirs.data.memory) };
  // Each computer updates only its own entry: keep the latest of each.
  if (mine.data.computers || theirs.data.computers) {
    const computers = { ...(theirs.data.computers || {}) };
    for (const [id, c] of Object.entries(mine.data.computers || {})) {
      if (!computers[id] || (c.updatedAt || 0) > (computers[id].updatedAt || 0)) computers[id] = c;
    }
    merged.computers = computers;
  }
  return merged;
}

const msgKey = (m) => m.id || `${m.role}|${m.createdAt}|${String(m.content || '').slice(0, 80)}`;

// The same chat changed on two devices before they synced: keep the newer
// version and add any messages only the other one has, so nothing is lost.
// How finished a copy of a message is: a reply still being written (or cut
// off) on one device mustn't replace the finished reply from the other.
const doneness = (m) => (m.pending ? 0 : !m.content && m.error ? 1 : 2);

function mergeChats(a, b) {
  const [newer, older] = (a.modifiedAt || 0) >= (b.modifiedAt || 0) ? [a, b] : [b, a];
  const seen = new Set(newer.messages.map(msgKey));
  const extra = older.messages.filter((m) => !seen.has(msgKey(m)));
  const merged = structuredClone(newer);
  const olderById = new Map(older.messages.filter((m) => m.id).map((m) => [m.id, m]));
  merged.messages = merged.messages.map((m) => {
    const other = m.id && olderById.get(m.id);
    return other && doneness(other) > doneness(m) ? structuredClone(other) : m;
  });
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

// ---- encryption settings -----------------------------------------------------------

async function newMeta(passphrase) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const keyBytes = await deriveKeyBytes(passphrase, salt, KDF_ITERATIONS);
  const meta = {
    app: 'balimda',
    format: FORMAT,
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: KDF_ITERATIONS,
    salt: toBase64(salt),
    check: await seal(await importKey(keyBytes), CHECK_TEXT)
  };
  return `${JSON.stringify(meta, null, 2)}\n`;
}

// The key for existing sync data, if the passphrase is right.
async function keyFromMeta(text, passphrase) {
  const meta = JSON.parse(text);
  if (meta.app !== 'balimda' || meta.format > FORMAT) throw new SyncError('This sync data is from a newer version of Balimda. Update the app.');
  const keyBytes = await deriveKeyBytes(passphrase, fromBase64(meta.salt), meta.iterations);
  const check = await unseal(await importKey(keyBytes), meta.check).catch(() => null);
  if (check !== CHECK_TEXT) throw new SyncError('Wrong sync passphrase. Use the same passphrase you chose on your first device.');
  return keyBytes;
}

// ---- sync ----------------------------------------------------------------------

class Sync {
  /**
   * @param storage     Storage instance
   * @param device      short device name used in commit messages
   * @param secrets     { encrypt, decrypt } for tokens and the key at rest
   * @param fetch       fetch implementation (desktop passes Electron's)
   * @param googleAuth  Google sign-in for this platform, or null:
   *                      signIn() -> { account, secret }   (interactive)
   *                      accessToken(secret, { force }) -> string
   *                      signOut(secret, account)
   * @param onEvent     receives { type: 'status', status } and
   *                    { type: 'changed', chats, deleted, settings }
   * @param auto        sync by itself a few seconds after local changes
   */
  constructor({ storage, device = 'device', secrets = {}, fetch, googleAuth = null, onEvent = () => {}, auto = true }) {
    this.auto = auto;
    this.storage = storage;
    this.device = device;
    this.encrypt = secrets.encrypt || ((s) => s);
    this.decrypt = secrets.decrypt || ((s) => s);
    this.fetch = fetch;
    this.googleAuth = googleAuth;
    this.onEvent = onEvent;
    this.config = null;
    this.remote = null;
    this.state = {};
    this.running = null;
    this.again = false;
    this.timer = null;
    this.lastPush = 0;
  }

  async load() {
    const cfg = await this.storage.readFile(CONFIG_FILE, null);
    if (cfg && (cfg.repo || cfg.provider)) {
      this.config = {
        ...cfg,
        provider: cfg.provider || 'github',
        token: cfg.token ? this.decrypt(cfg.token) : undefined,
        secret: cfg.secret ? this.decrypt(cfg.secret) : undefined,
        key: this.decrypt(cfg.key)
      };
      this.remote = this._remoteFor(this.config);
    }
    this.state = (await this.storage.readFile(STATE_FILE, null)) || {};
    if (this.auto) this.storage.onChange(() => this.soon());
    return this.status();
  }

  // Which destinations this build can use.
  providers() {
    return { github: true, gdrive: !!this.googleAuth };
  }

  // The sync key (base64), which "use my computer's models" derives its own
  // key from. Null when sync isn't set up.
  linkKey() {
    return this.config ? this.config.key : null;
  }

  status() {
    const d = this.remote ? this.remote.describe() : {};
    return {
      configured: !!this.config,
      provider: d.provider || null,
      label: d.label || null,
      link: d.link || null,
      repo: this.config && this.config.provider === 'github' ? this.config.repo : null,
      providers: this.providers(),
      running: !!this.running,
      lastSync: this.state.lastSync || null,
      error: this.state.error || null,
      offline: !!this.state.offline
    };
  }

  _emitStatus() {
    this.onEvent({ type: 'status', status: this.status() });
  }

  _remoteFor(cfg) {
    if (cfg.provider === 'gdrive') {
      return new DriveRemote({
        account: cfg.account,
        metaId: cfg.metaId,
        fetch: this.fetch,
        token: (force) => {
          if (!this.googleAuth) throw new SyncError('Google sign-in is not available in this version of the app.');
          return this.googleAuth.accessToken(cfg.secret, { force });
        }
      });
    }
    return new GitHubRemote({ repo: cfg.repo, token: cfg.token, branch: cfg.branch, fetch: this.fetch });
  }

  // Set up sync. The first device creates the encryption settings; later
  // devices must use the same passphrase.
  //   { provider: 'github', repo, token, passphrase }
  //   { provider: 'gdrive', passphrase }   (signs in to Google)
  async connect({ provider = 'github', repo, token, passphrase }) {
    if (String(passphrase || '').length < 8) throw new SyncError('Use a sync passphrase of at least 8 characters.');
    let cfg;
    let remote;
    if (provider === 'gdrive') {
      if (!this.googleAuth) throw new SyncError('Google sign-in is not available in this version of the app.');
      const signed = await this.googleAuth.signIn();
      cfg = { provider, account: signed.account || null, secret: signed.secret || null };
      remote = this._remoteFor(cfg);
      if (!cfg.account) {
        cfg.account = await remote.email().catch(() => null);
        remote.account = cfg.account;
      }
    } else {
      repo = parseRepo(repo);
      token = String(token || '').trim();
      if (!token) throw new SyncError('Enter a GitHub access token.');
      remote = await GitHubRemote.open({ repo, token, fetch: this.fetch });
      cfg = { provider, repo, branch: remote.branch, token };
    }

    let meta = await remote.readMeta();
    if (!meta) meta = await remote.createMeta(await newMeta(passphrase));
    const keyBytes = await keyFromMeta(meta, passphrase);
    if (remote.metaId) cfg.metaId = remote.metaId;

    this.config = { ...cfg, key: toBase64(keyBytes) };
    this.remote = remote;
    const saved = { ...cfg, key: this.encrypt(this.config.key) };
    if (cfg.token) saved.token = this.encrypt(cfg.token);
    if (cfg.secret) saved.secret = this.encrypt(cfg.secret);
    await this.storage.writeFile(CONFIG_FILE, saved);
    // A fresh start: every chat is compared with the synced copy once.
    this.state = {};
    await this.storage.writeFile(STATE_FILE, this.state);
    await this.run();
    return this.status();
  }

  async disconnect() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.running) await this.running.catch(() => {});
    const cfg = this.config;
    this.config = null;
    this.remote = null;
    this.state = {};
    await this.storage.writeFile(CONFIG_FILE, null);
    await this.storage.writeFile(STATE_FILE, null);
    if (cfg && cfg.provider === 'gdrive' && this.googleAuth && this.googleAuth.signOut) {
      await Promise.resolve(this.googleAuth.signOut(cfg.secret, cfg.account)).catch(() => {});
    }
    this._emitStatus();
    return this.status();
  }

  // Sync a few seconds after a change, and not more than every 20 seconds, so
  // a streaming reply turns into one upload instead of dozens.
  soon() {
    if (!this.config) return;
    clearTimeout(this.timer);
    const wait = Math.max(4000, this.lastPush + 20000 - Date.now());
    this.timer = setTimeout(() => this.run(), wait);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  // True when this device has changes the synced copy doesn't have yet.
  hasLocalChanges() {
    const base = this.state.chats || {};
    for (const c of this.storage.index) if (c.rev !== base[c.id]) return true;
    return false;
  }

  // Local changes that haven't been synced yet.
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
    const remote = this.remote;
    const key = await importKey(fromBase64(this.config.key));
    const storage = this.storage;

    const head = await remote.head();
    if (!head) throw new SyncError('The synced data is gone. Set up sync again.');
    const tomb = await storage.getTombstones();
    const shared = await storage.getSharedSettings();
    if (head === this.state.head && !this.hasLocalChanges() && !Object.keys(tomb).length && shared.modifiedAt === this.state.shared) {
      this.state.lastSync = Date.now();
      return;
    }

    const snap = await remote.load();
    const remoteIdx = remote.usesIndex
      ? (snap.indexText ? await unseal(key, snap.indexText) : { chats: {} })
      : { chats: snap.chats, shared: snap.shared };
    remoteIdx.chats = remoteIdx.chats || {};
    const next = { chats: { ...remoteIdx.chats }, shared: remoteIdx.shared || null };
    const base = this.state.chats || {};
    const local = new Map(storage.index.map((c) => [c.id, c]));
    const fetchChat = async (id) => {
      const text = await snap.readChat(id);
      return text ? unseal(key, text) : null;
    };

    // Versions are compared by revision id; modifiedAt only decides which of
    // two versions is newer.
    const pulls = [];
    const pushes = [];
    const merges = [];
    const localDeletes = [];
    const remoteDeletes = [];
    for (const id of new Set([...local.keys(), ...Object.keys(remoteIdx.chats), ...Object.keys(tomb)])) {
      const r = remoteIdx.chats[id];
      const l = local.get(id);
      if (l) {
        const lm = l.modifiedAt || 0;
        if (!r) pushes.push(id);
        else if (r.d) (lm > r.m ? pushes : localDeletes).push(id);
        else {
          const rr = r.r || `m${r.m}`;
          if (rr === l.rev) continue;
          const localChanged = l.rev !== base[id];
          const remoteChanged = rr !== base[id];
          if (localChanged && remoteChanged) merges.push(id);
          else (remoteChanged ? pulls : pushes).push(id);
        }
      } else if (r && !r.d) {
        if (tomb[id] != null && tomb[id] >= r.m) remoteDeletes.push(id);
        else pulls.push(id);
      }
    }

    const changed = [];
    const deleted = [];
    const skipped = []; // changed on this device while being downloaded: merged next run
    await pool(pulls, 6, async (id) => {
      const chat = await fetchChat(id);
      if (!chat) return;
      chat.modifiedAt = remoteIdx.chats[id].m;
      chat.rev = remoteIdx.chats[id].r || `m${chat.modifiedAt}`;
      const l = local.get(id);
      if (await storage.putSyncedChat(chat, { expect: l ? l.rev : null })) changed.push(id);
      else skipped.push(id);
    });
    await pool(merges, 6, async (id) => {
      const theirs = await fetchChat(id);
      const mine = await storage.getChat(id);
      if (!mine) return;
      if (!theirs) {
        pushes.push(id);
        return;
      }
      theirs.modifiedAt = remoteIdx.chats[id].m;
      const merged = mergeChats(mine, theirs);
      merged.modifiedAt = Math.max(Date.now(), mine.modifiedAt + 1, theirs.modifiedAt + 1);
      merged.rev = globalThis.crypto.randomUUID();
      if (!(await storage.putSyncedChat(merged, { expect: mine.rev || `m${mine.modifiedAt || mine.updatedAt || 1}` }))) {
        skipped.push(id);
        return;
      }
      changed.push(id);
      pushes.push(id);
    });
    for (const id of localDeletes) {
      await storage.deleteSyncedChat(id);
      deleted.push(id);
    }

    const writes = [];
    for (const id of pushes) {
      const chat = await storage.getChat(id);
      if (!chat) continue;
      // Chats saved before sync existed have no modifiedAt yet.
      chat.modifiedAt = chat.modifiedAt || chat.updatedAt || 1;
      chat.rev = chat.rev || `m${chat.modifiedAt}`;
      writes.push({ id, m: chat.modifiedAt, rev: chat.rev, text: await seal(key, chat) });
      next.chats[id] = { m: chat.modifiedAt, r: chat.rev };
    }
    const deletes = remoteDeletes.map((id) => {
      const m = Math.max(tomb[id], remoteIdx.chats[id].m);
      next.chats[id] = { m, d: true };
      return { id, m };
    });

    // Shared settings: newest wins, except that memory changed on both
    // devices since they last synced is merged.
    let settingsChanged = false;
    let sharedWrite = null;
    const rs = remoteIdx.shared;
    const localChanged = shared.modifiedAt > 0 && shared.modifiedAt !== this.state.shared;
    const remoteChanged = !!rs && rs.m !== this.state.shared;
    // What this run leaves in sync; a change made while it runs is picked
    // up by the next run.
    let synced = { m: shared.modifiedAt, memory: shared.data.memory };
    const push = async (data, m) => {
      sharedWrite = { m, text: await seal(key, data) };
      next.shared = { m };
      synced = { m, memory: data.memory };
    };
    if (localChanged && remoteChanged && rs.m !== shared.modifiedAt) {
      const rsText = await snap.readShared();
      const theirs = rsText ? { modifiedAt: rs.m, data: await unseal(key, rsText) } : null;
      const merged = theirs ? mergeShared(this.state.sharedMemory, shared, theirs) : shared.data;
      const same = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
      if (theirs && same(merged, theirs.data)) {
        await storage.applySharedSettings(theirs.data, rs.m);
        synced = { m: rs.m, memory: theirs.data.memory };
        settingsChanged = true;
      } else if (!theirs || same(merged, shared.data)) {
        const m = Math.max(shared.modifiedAt, rs.m + 1);
        if (m !== shared.modifiedAt) await storage.applySharedSettings(shared.data, m);
        await push(shared.data, m);
      } else {
        const m = Math.max(Date.now(), shared.modifiedAt + 1, rs.m + 1);
        await storage.applySharedSettings(merged, m);
        await push(merged, m);
        settingsChanged = true;
      }
    } else if (rs && rs.m > shared.modifiedAt) {
      const rsText = await snap.readShared();
      if (rsText) {
        const data = await unseal(key, rsText);
        await storage.applySharedSettings(data, rs.m);
        synced = { m: rs.m, memory: data.memory };
        settingsChanged = true;
      }
    } else if (!rs || shared.modifiedAt > rs.m) {
      await push(shared.data, shared.modifiedAt);
    }

    let newHead = head;
    if (writes.length || deletes.length || sharedWrite) {
      newHead = await remote.save(snap, {
        writes,
        deletes,
        shared: sharedWrite,
        indexText: remote.usesIndex ? await seal(key, next) : null,
        message: `Sync from ${this.device}`
      });
      this.lastPush = Date.now();
    }

    // What is now in the synced copy. A chat saved on this device while this
    // run was going differs from it, so the next run uploads it (or merges
    // it); taking the local versions here would mark that change as synced
    // and let the next run download the older copy over it.
    const nextBase = {};
    for (const [id, e] of Object.entries(next.chats)) if (!e.d) nextBase[id] = e.r || `m${e.m}`;
    for (const id of skipped) {
      if (base[id] != null) nextBase[id] = base[id];
      else delete nextBase[id];
    }
    this.state = {
      ...this.state,
      head: newHead,
      chats: nextBase,
      shared: synced.m,
      sharedMemory: synced.memory || '',
      lastSync: Date.now()
    };
    const handled = Object.keys(tomb).filter((id) => !local.has(id));
    if (handled.length) await storage.clearTombstones(handled);

    if (changed.length || deleted.length || settingsChanged) {
      this.onEvent({ type: 'changed', chats: changed, deleted, settings: settingsChanged });
    }
  }
}

module.exports = { Sync, SyncError, GitHub, GitHubRemote, DriveRemote, mergeChats, mergeMemory, toBase64, fromBase64, parseRepo, seal, unseal, importKey, deriveKeyBytes };
