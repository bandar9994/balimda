// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../src/storage');
const { nodeFsBackend } = require('../src/backends/node-fs');
const { Sync, mergeChats, parseRepo } = require('../src/sync');

const TOKEN = 'github_pat_test';
const PASS = 'correct horse battery';

// A small in-memory stand-in for the parts of the GitHub API that sync uses.
function fakeGitHub({ isPrivate = true } = {}) {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const gh = { ref: null, requests: 0, writes: 0, blobs };
  const sha = (x) => crypto.createHash('sha1').update(JSON.stringify(x) + Math.random()).digest('hex');
  const putBlob = (content) => {
    const id = sha(content);
    blobs.set(id, content);
    return id;
  };
  const putTree = (files) => {
    const id = sha([...files]);
    trees.set(id, files);
    return id;
  };
  const putCommit = (tree, parents) => {
    const id = sha({ tree, parents });
    commits.set(id, { tree, parents });
    return id;
  };
  const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });

  gh.fetch = async (url, opts = {}) => {
    gh.requests++;
    await new Promise((r) => setImmediate(r));
    if (opts.headers.Authorization !== `Bearer ${TOKEN}`) return reply(401, { message: 'Bad credentials' });
    const u = new URL(url);
    const m = u.pathname.match(/^\/repos\/me\/chats(.*)$/);
    if (!m) return reply(404, { message: 'Not Found' });
    const route = `${opts.method} ${m[1]}`;
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (opts.method !== 'GET') gh.writes++;
    let r;
    if (route === 'GET ') return reply(200, { private: isPrivate, default_branch: 'main' });
    if (route === 'GET /git/ref/heads/main') return gh.ref ? reply(200, { object: { sha: gh.ref } }) : reply(409, { message: 'Git Repository is empty.' });
    if ((r = route.match(/^GET \/git\/commits\/(\w+)$/))) return reply(200, { tree: { sha: commits.get(r[1]).tree } });
    if ((r = route.match(/^GET \/git\/trees\/(\w+)$/))) {
      return reply(200, { truncated: false, tree: [...trees.get(r[1])].map(([p, s]) => ({ path: p, type: 'blob', sha: s })) });
    }
    if ((r = route.match(/^GET \/git\/blobs\/(\w+)$/))) return reply(200, { content: Buffer.from(blobs.get(r[1])).toString('base64') });
    if (route === 'PUT /contents/README.md') {
      if (gh.ref) return reply(422, { message: 'exists' });
      gh.ref = putCommit(putTree(new Map([['README.md', putBlob(Buffer.from(body.content, 'base64').toString())]])), []);
      return reply(201, { commit: { sha: gh.ref } });
    }
    if (route === 'POST /git/trees') {
      const files = new Map(trees.get(body.base_tree));
      for (const e of body.tree) {
        if (e.sha === null) {
          if (!files.has(e.path)) return reply(422, { message: `path ${e.path} not found` });
          files.delete(e.path);
        } else files.set(e.path, e.content != null ? putBlob(e.content) : e.sha);
      }
      return reply(201, { sha: putTree(files) });
    }
    if (route === 'POST /git/commits') return reply(201, { sha: putCommit(body.tree, body.parents) });
    if (route === 'PATCH /git/refs/heads/main') {
      if (!commits.get(body.sha).parents.includes(gh.ref)) {
        gh.rejected++;
        return reply(422, { message: 'Update is not a fast forward' });
      }
      gh.ref = body.sha;
      return reply(200, {});
    }
    return reply(404, { message: `no route ${route}` });
  };
  gh.rejected = 0;
  gh.files = () => new Set(trees.get(commits.get(gh.ref).tree).keys());
  return gh;
}

// A small in-memory stand-in for the Google Drive API (appDataFolder only).
function fakeDrive({ expireFirstToken = false } = {}) {
  const files = new Map();
  let clock = Date.parse('2026-01-01T00:00:00Z');
  let n = 0;
  const drive = { requests: 0, files, email: 'bandar@example.com', expired: expireFirstToken };
  const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)) });
  const stamp = () => new Date(clock++).toISOString();
  const parseMultipart = (contentType, body) => {
    const b = contentType.match(/boundary=(.+)$/)[1];
    const parts = body.split(`--${b}`).slice(1, -1).map((p) => p.slice(p.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''));
    return { meta: JSON.parse(parts[0]), content: parts[1] };
  };
  const view = (f) => ({ id: f.id, name: f.name, appProperties: f.appProperties, createdTime: f.createdTime, modifiedTime: f.modifiedTime });

  drive.fetch = async (url, opts = {}) => {
    drive.requests++;
    await new Promise((r) => setImmediate(r));
    const auth = opts.headers.Authorization;
    if (auth === 'Bearer token' && drive.expired) return reply(401, { error: { message: 'Invalid Credentials' } });
    if (auth !== 'Bearer token' && auth !== 'Bearer fresh') return reply(401, { error: { message: 'Invalid Credentials' } });
    const u = new URL(url);
    const method = opts.method || 'GET';
    let m;
    if (method === 'GET' && u.pathname === '/drive/v3/about') return reply(200, { user: { emailAddress: drive.email } });
    if (method === 'GET' && u.pathname === '/drive/v3/files') {
      assert.strictEqual(u.searchParams.get('spaces'), 'appDataFolder');
      let list = [...files.values()];
      const q = u.searchParams.get('q');
      if (q) list = list.filter((f) => f.name === q.match(/name = '(.+)'/)[1]);
      if (u.searchParams.get('orderBy') === 'modifiedTime desc') list.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
      return reply(200, { files: list.slice(0, Number(u.searchParams.get('pageSize')) || 1000).map(view) });
    }
    if ((m = u.pathname.match(/^\/drive\/v3\/files\/(\w+)$/))) {
      const f = files.get(m[1]);
      if (!f) return reply(404, { error: { message: 'File not found' } });
      if (method === 'DELETE') {
        files.delete(f.id);
        return reply(204, null);
      }
      return reply(200, f.content);
    }
    if (method === 'POST' && u.pathname === '/upload/drive/v3/files') {
      const { meta, content } = parseMultipart(opts.headers['Content-Type'], opts.body);
      assert.deepStrictEqual(meta.parents, ['appDataFolder']);
      const id = `f${++n}`;
      const t = stamp();
      files.set(id, { id, name: meta.name, content, appProperties: meta.appProperties || {}, createdTime: t, modifiedTime: t });
      return reply(200, { id });
    }
    if (method === 'PATCH' && (m = u.pathname.match(/^\/upload\/drive\/v3\/files\/(\w+)$/))) {
      const f = files.get(m[1]);
      if (!f) return reply(404, { error: { message: 'File not found' } });
      const { meta, content } = parseMultipart(opts.headers['Content-Type'], opts.body);
      f.content = content;
      f.appProperties = { ...f.appProperties, ...(meta.appProperties || {}) };
      f.modifiedTime = stamp();
      return reply(200, { id: f.id });
    }
    return reply(404, { error: { message: `no route ${method} ${u.pathname}` } });
  };
  drive.names = () => new Set([...files.values()].map((f) => f.name));
  drive.contents = () => [...files.values()].map((f) => f.content);
  return drive;
}

function fakeGoogleAuth(drive) {
  const auth = { signedOut: false };
  auth.signIn = async () => ({ account: null, secret: 'refresh-token' });
  auth.accessToken = async (secret, { force } = {}) => {
    assert.strictEqual(secret, 'refresh-token');
    if (force) drive.expired = false;
    return force ? 'fresh' : 'token';
  };
  auth.signOut = async () => {
    auth.signedOut = true;
  };
  return auth;
}

// The same tests run against both sync destinations.
const BACKENDS = {
  github: () => {
    const gh = fakeGitHub();
    return {
      server: gh,
      fetch: gh.fetch,
      connect: { provider: 'github', repo: 'me/chats', token: TOKEN },
      has: (name) => gh.files().has(name),
      stored: () => [...gh.blobs.values()],
      requests: () => gh.requests
    };
  },
  gdrive: () => {
    const drive = fakeDrive();
    return {
      server: drive,
      fetch: drive.fetch,
      googleAuth: fakeGoogleAuth(drive),
      connect: { provider: 'gdrive' },
      has: (name) => [...drive.files.values()].some((f) => f.name === name && f.appProperties.d !== '1'),
      stored: () => drive.contents(),
      requests: () => drive.requests
    };
  }
};

async function device(backend, name) {
  const storage = await Storage.open(nodeFsBackend(fs.mkdtempSync(path.join(os.tmpdir(), `balimda-sync-${name}-`))));
  const events = [];
  const sync = new Sync({
    storage,
    device: name,
    fetch: backend.fetch,
    googleAuth: backend.googleAuth,
    auto: false,
    onEvent: (e) => e.type === 'changed' && events.push(e)
  });
  await sync.load();
  const connect = (passphrase = PASS, extra = {}) => sync.connect({ ...backend.connect, passphrase, ...extra });
  return { storage, sync, events, connect };
}

async function addMessage(storage, id, content, createdAt = Date.now()) {
  const chat = await storage.getChat(id);
  chat.messages.push({ id: crypto.randomUUID(), role: 'user', content, createdAt });
  chat.updatedAt = Date.now();
  await storage.saveChat(chat);
  return chat;
}

const contents = async (storage, id) => (await storage.getChat(id)).messages.map((m) => m.content);

test('parses repository names and links', () => {
  assert.strictEqual(parseRepo('me/chats'), 'me/chats');
  assert.strictEqual(parseRepo('https://github.com/me/chats.git'), 'me/chats');
  assert.throws(() => parseRepo('chats'));
});

for (const [kind, makeBackend] of Object.entries(BACKENDS)) {
  test(`${kind}: continue a chat from the PC on the phone and back`, async () => {
    const backend = makeBackend();
    const pc = await device(backend, 'pc');
    const chat = await pc.storage.createChat({ title: 'Trip' });
    await addMessage(pc.storage, chat.id, 'Plan a trip to Riyadh');
    await pc.connect();
    assert.strictEqual(pc.sync.status().error, null);
    assert.ok(backend.has(`chats/${chat.id}.enc`));

    // Nothing readable is stored.
    for (const text of backend.stored()) {
      assert.ok(!text.includes('Riyadh'), 'chat text must be encrypted');
      assert.ok(!text.includes('Trip'), 'titles must be encrypted');
    }

    const phone = await device(backend, 'phone');
    await phone.connect(PASS, kind === 'github' ? { repo: 'https://github.com/me/chats' } : {});
    assert.deepStrictEqual(await contents(phone.storage, chat.id), ['Plan a trip to Riyadh']);
    assert.strictEqual((await phone.storage.listChats())[0].title, 'Trip');

    await addMessage(phone.storage, chat.id, 'Add a day in AlUla');
    await phone.sync.run();
    await pc.sync.run();
    assert.deepStrictEqual(await contents(pc.storage, chat.id), ['Plan a trip to Riyadh', 'Add a day in AlUla']);
    assert.deepStrictEqual(pc.events.at(-1).chats, [chat.id]);

    // An idle check is a single request.
    const before = backend.requests();
    await pc.sync.run();
    assert.strictEqual(backend.requests() - before, 1);
    assert.strictEqual(pc.sync.status().error, null);
  });

  test(`${kind}: deleting a chat removes it on the other device`, async () => {
    const backend = makeBackend();
    const pc = await device(backend, 'pc');
    const keep = await pc.storage.createChat({ title: 'Keep' });
    const drop = await pc.storage.createChat({ title: 'Drop' });
    await pc.connect();
    const phone = await device(backend, 'phone');
    await phone.connect();
    assert.strictEqual(phone.storage.index.length, 2);

    await pc.storage.deleteChat(drop.id);
    await pc.sync.run();
    assert.ok(!backend.has(`chats/${drop.id}.enc`));
    assert.deepStrictEqual(await pc.storage.getTombstones(), {});
    await phone.sync.run();
    assert.deepStrictEqual(phone.storage.index.map((c) => c.id), [keep.id]);
    assert.deepStrictEqual(phone.events.at(-1).deleted, [drop.id]);
  });

  test(`${kind}: changes to the same chat on both devices are merged`, async () => {
    const backend = makeBackend();
    const pc = await device(backend, 'pc');
    const chat = await pc.storage.createChat({ title: 'Notes' });
    await addMessage(pc.storage, chat.id, 'one', 1000);
    await pc.connect();
    const phone = await device(backend, 'phone');
    await phone.connect();

    await addMessage(pc.storage, chat.id, 'from pc', 2000);
    await addMessage(phone.storage, chat.id, 'from phone', 3000);
    await pc.sync.run();
    await phone.sync.run();
    await pc.sync.run();
    const expected = ['one', 'from pc', 'from phone'];
    assert.deepStrictEqual(await contents(phone.storage, chat.id), expected);
    assert.deepStrictEqual(await contents(pc.storage, chat.id), expected);
  });

  test(`${kind}: edits saved in the same millisecond on two devices are both kept`, async () => {
    const backend = makeBackend();
    const pc = await device(backend, 'pc');
    const chat = await pc.storage.createChat({ title: 'Same time' });
    await pc.connect();
    const phone = await device(backend, 'phone');
    await phone.connect();

    const realNow = Date.now;
    const frozen = realNow() + 1000;
    Date.now = () => frozen;
    try {
      await addMessage(pc.storage, chat.id, 'from pc', 1);
      await addMessage(phone.storage, chat.id, 'from phone', 2);
    } finally {
      Date.now = realNow;
    }
    await pc.sync.run();
    await phone.sync.run();
    await pc.sync.run();
    assert.deepStrictEqual(await contents(phone.storage, chat.id), ['from pc', 'from phone']);
    assert.deepStrictEqual(await contents(pc.storage, chat.id), ['from pc', 'from phone']);
  });

  test(`${kind}: two devices syncing at the same moment both get through`, async () => {
    const backend = makeBackend();
    const pc = await device(backend, 'pc');
    await pc.connect();
    const phone = await device(backend, 'phone');
    await phone.connect();
    const a = await pc.storage.createChat({ title: 'A' });
    const b = await phone.storage.createChat({ title: 'B' });
    await Promise.all([pc.sync.run(), phone.sync.run()]);
    if (kind === 'github') assert.ok(backend.server.rejected >= 1, 'one push should have been rejected and retried');
    await pc.sync.run();
    await phone.sync.run();
    assert.strictEqual(pc.sync.status().error, null);
    assert.strictEqual(phone.sync.status().error, null);
    const ids = (s) => s.storage.index.map((c) => c.id).sort();
    assert.deepStrictEqual(ids(pc), [a.id, b.id].sort());
    assert.deepStrictEqual(ids(phone), [a.id, b.id].sort());
  });

  test(`${kind}: assistants and memory follow you, API keys do not`, async () => {
    const backend = makeBackend();
    const pc = await device(backend, 'pc');
    const settings = await pc.storage.getSettings();
    settings.memory = '- Prefers short answers';
    settings.providers.anthropic.apiKey = 'sk-secret';
    settings.assistants.push({ id: 'chef', name: 'Chef', emoji: '🍳', systemPrompt: 'Cook.' });
    await pc.storage.saveSettings(settings);
    await pc.connect();

    const phone = await device(backend, 'phone');
    await phone.connect();
    const got = await phone.storage.getSettings();
    assert.strictEqual(got.memory, '- Prefers short answers');
    assert.ok(got.assistants.some((a) => a.id === 'chef'));
    assert.strictEqual(got.providers.anthropic.apiKey, '');
    assert.ok(phone.events.at(-1).settings);
  });

  test(`${kind}: refuses a wrong passphrase`, async () => {
    const backend = makeBackend();
    const pc = await device(backend, 'pc');
    await pc.connect();
    const phone = await device(backend, 'phone');
    await assert.rejects(phone.connect('not the same one'), /Wrong sync passphrase/);
    assert.strictEqual(phone.sync.status().configured, false);
  });

  test(`${kind}: sync settings survive a restart and disconnect forgets them`, async () => {
    const backend = makeBackend();
    const pc = await device(backend, 'pc');
    await pc.connect();
    const again = new Sync({ storage: pc.storage, fetch: backend.fetch, googleAuth: backend.googleAuth, auto: false });
    const status = await again.load();
    assert.strictEqual(status.configured, true);
    assert.strictEqual(status.provider, kind);
    assert.strictEqual((await again.run()).error, null);
    await again.disconnect();
    assert.strictEqual((await new Sync({ storage: pc.storage, auto: false }).load()).configured, false);
  });
}

test('github: refuses a public repository and a bad token', async () => {
  const gh = fakeGitHub();
  const backend = { fetch: gh.fetch, connect: { provider: 'github', repo: 'me/chats', token: 'nope' } };
  const phone = await device(backend, 'phone');
  await assert.rejects(phone.connect(), /token/);

  const pub = fakeGitHub({ isPrivate: false });
  const other = await device({ fetch: pub.fetch, connect: { provider: 'github', repo: 'me/chats', token: TOKEN } }, 'other');
  await assert.rejects(other.connect(), /public/);
});

test('gdrive: shows the Google account, renews an expired sign-in and signs out', async () => {
  const backend = BACKENDS.gdrive();
  const pc = await device(backend, 'pc');
  const status = await pc.connect();
  assert.strictEqual(status.label, 'Google Drive (bandar@example.com)');
  assert.strictEqual(status.provider, 'gdrive');

  backend.server.expired = true;
  await pc.storage.createChat({ title: 'After expiry' });
  assert.strictEqual((await pc.sync.run()).error, null);
  assert.strictEqual(pc.storage.index.length, 1);

  await pc.sync.disconnect();
  assert.ok(backend.googleAuth.signedOut);
});

test('gdrive: cleans up a chat file created twice at the same moment', async () => {
  const backend = BACKENDS.gdrive();
  const pc = await device(backend, 'pc');
  const chat = await pc.storage.createChat({ title: 'Twice' });
  await addMessage(pc.storage, chat.id, 'hello');
  await pc.connect();
  // Simulate a second, older copy of the same chat file.
  const [orig] = [...backend.server.files.values()].filter((f) => f.name === `chats/${chat.id}.enc`);
  backend.server.files.set('dup', { ...orig, id: 'dup', appProperties: { m: '1', d: '0' } });
  const phone = await device(backend, 'phone');
  await phone.connect();
  assert.deepStrictEqual(await contents(phone.storage, chat.id), ['hello']);
  assert.ok(!backend.server.files.has('dup'));
});

test('gdrive: not offered without Google sign-in', async () => {
  const backend = BACKENDS.gdrive();
  const pc = await device({ ...backend, googleAuth: null }, 'pc');
  assert.strictEqual(pc.sync.status().providers.gdrive, false);
  await assert.rejects(pc.connect(), /not available/);
});

test('mergeChats keeps every message once, in time order', () => {
  const a = { modifiedAt: 2, updatedAt: 2, messages: [{ id: '1', createdAt: 1 }, { id: '3', createdAt: 3 }] };
  const b = { modifiedAt: 1, updatedAt: 1, messages: [{ id: '1', createdAt: 1 }, { id: '2', createdAt: 2 }] };
  assert.deepStrictEqual(mergeChats(a, b).messages.map((m) => m.id), ['1', '2', '3']);
});
