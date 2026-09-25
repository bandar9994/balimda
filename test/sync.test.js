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

async function device(gh, name) {
  const storage = await Storage.open(nodeFsBackend(fs.mkdtempSync(path.join(os.tmpdir(), `balimda-sync-${name}-`))));
  const events = [];
  const sync = new Sync({ storage, device: name, fetch: gh.fetch, auto: false, onEvent: (e) => e.type === 'changed' && events.push(e) });
  await sync.load();
  return { storage, sync, events };
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

test('continue a chat from the PC on the phone and back', async () => {
  const gh = fakeGitHub();
  const pc = await device(gh, 'pc');
  const chat = await pc.storage.createChat({ title: 'Trip' });
  await addMessage(pc.storage, chat.id, 'Plan a trip to Riyadh');
  await pc.sync.connect({ repo: 'me/chats', token: TOKEN, passphrase: PASS });
  assert.strictEqual(pc.sync.status().error, null);
  assert.ok(gh.files().has(`chats/${chat.id}.enc`));

  // Nothing readable is stored on GitHub.
  for (const text of gh.blobs.values()) {
    assert.ok(!text.includes('Riyadh'), 'chat text must be encrypted');
    assert.ok(!text.includes('Trip'), 'titles must be encrypted');
  }

  const phone = await device(gh, 'phone');
  await phone.sync.connect({ repo: 'https://github.com/me/chats', token: TOKEN, passphrase: PASS });
  assert.deepStrictEqual(await contents(phone.storage, chat.id), ['Plan a trip to Riyadh']);
  assert.strictEqual((await phone.storage.listChats())[0].title, 'Trip');

  await addMessage(phone.storage, chat.id, 'Add a day in AlUla');
  await phone.sync.run();
  await pc.sync.run();
  assert.deepStrictEqual(await contents(pc.storage, chat.id), ['Plan a trip to Riyadh', 'Add a day in AlUla']);
  assert.deepStrictEqual(pc.events.at(-1).chats, [chat.id]);

  // An idle check is a single request.
  const before = gh.requests;
  await pc.sync.run();
  assert.strictEqual(gh.requests - before, 1);
});

test('deleting a chat removes it on the other device', async () => {
  const gh = fakeGitHub();
  const pc = await device(gh, 'pc');
  const keep = await pc.storage.createChat({ title: 'Keep' });
  const drop = await pc.storage.createChat({ title: 'Drop' });
  await pc.sync.connect({ repo: 'me/chats', token: TOKEN, passphrase: PASS });
  const phone = await device(gh, 'phone');
  await phone.sync.connect({ repo: 'me/chats', token: TOKEN, passphrase: PASS });
  assert.strictEqual(phone.storage.index.length, 2);

  await pc.storage.deleteChat(drop.id);
  await pc.sync.run();
  assert.ok(!gh.files().has(`chats/${drop.id}.enc`));
  assert.deepStrictEqual(await pc.storage.getTombstones(), {});
  await phone.sync.run();
  assert.deepStrictEqual(phone.storage.index.map((c) => c.id), [keep.id]);
  assert.deepStrictEqual(phone.events.at(-1).deleted, [drop.id]);
});

test('changes to the same chat on both devices are merged', async () => {
  const gh = fakeGitHub();
  const pc = await device(gh, 'pc');
  const chat = await pc.storage.createChat({ title: 'Notes' });
  await addMessage(pc.storage, chat.id, 'one', 1000);
  await pc.sync.connect({ repo: 'me/chats', token: TOKEN, passphrase: PASS });
  const phone = await device(gh, 'phone');
  await phone.sync.connect({ repo: 'me/chats', token: TOKEN, passphrase: PASS });

  await addMessage(pc.storage, chat.id, 'from pc', 2000);
  await addMessage(phone.storage, chat.id, 'from phone', 3000);
  await pc.sync.run();
  await phone.sync.run();
  await pc.sync.run();
  const expected = ['one', 'from pc', 'from phone'];
  assert.deepStrictEqual(await contents(phone.storage, chat.id), expected);
  assert.deepStrictEqual(await contents(pc.storage, chat.id), expected);
});

test('two devices syncing at the same moment both get through', async () => {
  const gh = fakeGitHub();
  const pc = await device(gh, 'pc');
  await pc.sync.connect({ repo: 'me/chats', token: TOKEN, passphrase: PASS });
  const phone = await device(gh, 'phone');
  await phone.sync.connect({ repo: 'me/chats', token: TOKEN, passphrase: PASS });
  const a = await pc.storage.createChat({ title: 'A' });
  const b = await phone.storage.createChat({ title: 'B' });
  await Promise.all([pc.sync.run(), phone.sync.run()]);
  assert.ok(gh.rejected >= 1, 'one push should have been rejected and retried');
  await pc.sync.run();
  await phone.sync.run();
  assert.strictEqual(pc.sync.status().error, null);
  assert.strictEqual(phone.sync.status().error, null);
  const ids = (s) => s.storage.index.map((c) => c.id).sort();
  assert.deepStrictEqual(ids(pc), [a.id, b.id].sort());
  assert.deepStrictEqual(ids(phone), [a.id, b.id].sort());
});

test('assistants and memory follow you, API keys do not', async () => {
  const gh = fakeGitHub();
  const pc = await device(gh, 'pc');
  const settings = await pc.storage.getSettings();
  settings.memory = '- Prefers short answers';
  settings.providers.anthropic.apiKey = 'sk-secret';
  settings.assistants.push({ id: 'chef', name: 'Chef', emoji: '🍳', systemPrompt: 'Cook.' });
  await pc.storage.saveSettings(settings);
  await pc.sync.connect({ repo: 'me/chats', token: TOKEN, passphrase: PASS });

  const phone = await device(gh, 'phone');
  await phone.sync.connect({ repo: 'me/chats', token: TOKEN, passphrase: PASS });
  const got = await phone.storage.getSettings();
  assert.strictEqual(got.memory, '- Prefers short answers');
  assert.ok(got.assistants.some((a) => a.id === 'chef'));
  assert.strictEqual(got.providers.anthropic.apiKey, '');
  assert.ok(phone.events.at(-1).settings);
});

test('refuses a wrong passphrase, a public repository and a bad token', async () => {
  const gh = fakeGitHub();
  const pc = await device(gh, 'pc');
  await pc.sync.connect({ repo: 'me/chats', token: TOKEN, passphrase: PASS });
  const phone = await device(gh, 'phone');
  await assert.rejects(phone.sync.connect({ repo: 'me/chats', token: TOKEN, passphrase: 'not the same one' }), /Wrong sync passphrase/);
  await assert.rejects(phone.sync.connect({ repo: 'me/chats', token: 'nope', passphrase: PASS }), /token/);
  assert.strictEqual(phone.sync.status().configured, false);

  const pub = fakeGitHub({ isPrivate: false });
  const other = await device(pub, 'other');
  await assert.rejects(other.sync.connect({ repo: 'me/chats', token: TOKEN, passphrase: PASS }), /public/);
});

test('sync settings survive a restart and disconnect forgets them', async () => {
  const gh = fakeGitHub();
  const pc = await device(gh, 'pc');
  await pc.sync.connect({ repo: 'me/chats', token: TOKEN, passphrase: PASS });
  const again = new Sync({ storage: pc.storage, fetch: gh.fetch, auto: false });
  const status = await again.load();
  assert.strictEqual(status.configured, true);
  assert.strictEqual(status.repo, 'me/chats');
  await again.disconnect();
  assert.strictEqual((await new Sync({ storage: pc.storage, auto: false }).load()).configured, false);
});

test('mergeChats keeps every message once, in time order', () => {
  const a = { modifiedAt: 2, updatedAt: 2, messages: [{ id: '1', createdAt: 1 }, { id: '3', createdAt: 3 }] };
  const b = { modifiedAt: 1, updatedAt: 1, messages: [{ id: '1', createdAt: 1 }, { id: '2', createdAt: 2 }] };
  assert.deepStrictEqual(mergeChats(a, b).messages.map((m) => m.id), ['1', '2', '3']);
});
