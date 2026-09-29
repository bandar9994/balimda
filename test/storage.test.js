// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../src/storage');
const { nodeFsBackend } = require('../src/backends/node-fs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'balimda-test-'));
}

async function tmpStorage(options) {
  const dir = tmpDir();
  return { dir, storage: await Storage.open(nodeFsBackend(dir), options) };
}

test('chats persist across restarts', async () => {
  const { dir, storage } = await tmpStorage();
  const chat = await storage.createChat({ assistantId: 'default', model: { provider: 'ollama', model: 'llama3.2' } });
  chat.title = 'Trip planning';
  chat.messages.push({ id: 'm1', role: 'user', content: 'Plan a trip to Riyadh' });
  await storage.saveChat(chat);

  const reopened = await Storage.open(nodeFsBackend(dir));
  const list = await reopened.listChats();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].title, 'Trip planning');
  assert.strictEqual(list[0].preview, 'Plan a trip to Riyadh');
  assert.strictEqual((await reopened.getChat(chat.id)).messages[0].content, 'Plan a trip to Riyadh');
});

test('index is rebuilt when missing', async () => {
  const { dir, storage } = await tmpStorage();
  await storage.createChat({ title: 'A' });
  await storage.createChat({ title: 'B' });
  fs.unlinkSync(path.join(dir, 'index.json'));
  assert.strictEqual((await (await Storage.open(nodeFsBackend(dir))).listChats()).length, 2);
});

test('concurrent saves keep every chat in the index', async () => {
  const { dir, storage } = await tmpStorage();
  await Promise.all(Array.from({ length: 20 }, (_, i) => storage.createChat({ title: `chat ${i}` })));
  const reopened = await Storage.open(nodeFsBackend(dir));
  assert.strictEqual((await reopened.listChats()).length, 20);
});

test('pinned chats sort first, then most recent', async () => {
  const { storage } = await tmpStorage();
  const a = await storage.createChat({ title: 'old pinned' });
  a.pinned = true;
  a.updatedAt = 1;
  await storage.saveChat(a);
  const b = await storage.createChat({ title: 'new' });
  b.updatedAt = 100;
  await storage.saveChat(b);
  const c = await storage.createChat({ title: 'older' });
  c.updatedAt = 50;
  await storage.saveChat(c);
  assert.deepStrictEqual((await storage.listChats()).map((x) => x.title), ['old pinned', 'new', 'older']);
});

test('search finds text inside messages', async () => {
  const { storage } = await tmpStorage();
  const chat = await storage.createChat({ title: 'Recipes' });
  chat.messages.push({ role: 'assistant', content: 'Kabsa uses rice, chicken and baharat spices.' });
  await storage.saveChat(chat);
  await storage.createChat({ title: 'Other' });
  const hits = await storage.searchChats('baharat');
  assert.strictEqual(hits.length, 1);
  assert.match(hits[0].preview, /baharat/);
  assert.strictEqual((await storage.searchChats('recipes')).length, 1);
});

test('delete removes chat file and index entry', async () => {
  const { dir, storage } = await tmpStorage();
  const chat = await storage.createChat();
  await storage.deleteChat(chat.id);
  assert.strictEqual((await storage.listChats()).length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'chats', `${chat.id}.json`)));
});

test('rejects path traversal ids', async () => {
  const { storage } = await tmpStorage();
  await assert.rejects(storage.getChat('../settings'));
  await assert.rejects(storage.deleteChat('../settings'));
  await assert.rejects(nodeFsBackend(tmpDir()).read('../../etc/passwd'));
});

test('export and import round trip', async () => {
  const { storage } = await tmpStorage();
  const chat = await storage.createChat({ title: 'Keep me' });
  chat.messages.push({ role: 'user', content: 'hi' });
  await storage.saveChat(chat);
  const backup = await storage.exportAll();

  const other = (await tmpStorage()).storage;
  assert.strictEqual(await other.importAll(backup), 1);
  assert.strictEqual((await other.listChats())[0].title, 'Keep me');
});

test('settings merge with defaults and encrypt api keys', async () => {
  const secrets = { encrypt: (s) => `x:${s}`, decrypt: (s) => s.replace(/^x:/, '') };
  const { dir, storage } = await tmpStorage({ secrets });
  const s = await storage.getSettings();
  assert.strictEqual(s.providers.ollama.baseUrl, 'http://127.0.0.1:11434');
  s.providers.anthropic.apiKey = 'sk-secret';
  s.memory = 'I like tea';
  await storage.saveSettings(s);

  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.strictEqual(raw.providers.anthropic.apiKey, 'x:sk-secret');
  const again = await storage.getSettings();
  assert.strictEqual(again.providers.anthropic.apiKey, 'sk-secret');
  assert.strictEqual(again.memory, 'I like tea');
});

test('platform defaults override built-in defaults', async () => {
  const { storage } = await tmpStorage({
    defaults: { sendOnEnter: false, providers: { onDevice: { enabled: true }, ollama: { enabled: false } } }
  });
  const s = await storage.getSettings();
  assert.strictEqual(s.sendOnEnter, false);
  assert.strictEqual(s.providers.ollama.enabled, false);
  assert.strictEqual(s.providers.ollama.baseUrl, 'http://127.0.0.1:11434');
  assert.deepStrictEqual(s.providers.onDevice, { enabled: true });
});

test('app state is remembered', async () => {
  const { dir, storage } = await tmpStorage();
  await storage.saveState({ lastChatId: 'abc', drafts: { abc: 'half typed' } });
  await storage.saveState({ sidebarCollapsed: true });
  const state = await (await Storage.open(nodeFsBackend(dir))).getState();
  assert.deepStrictEqual(state, { lastChatId: 'abc', drafts: { abc: 'half typed' }, sidebarCollapsed: true });
});

test('preview hides reasoning blocks', async () => {
  const { storage } = await tmpStorage();
  const chat = await storage.createChat();
  chat.messages.push({ role: 'assistant', content: '<think>secret plan</think>\n\n**Final**   answer' });
  await storage.saveChat(chat);
  assert.strictEqual((await storage.listChats())[0].preview, 'Final answer');
});

test('data saved before the rename (pals / palId) still loads', async () => {
  const { dir, storage } = await tmpStorage();
  // settings and a chat as the old "Pal" app wrote them
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ pals: [{ id: 'mine', name: 'My helper', systemPrompt: 'x' }] }));
  fs.writeFileSync(path.join(dir, 'chats', 'old-1.json'), JSON.stringify({ id: 'old-1', title: 'Old chat', palId: 'mine', messages: [] }));
  const reopened = await Storage.open(nodeFsBackend(dir));
  await reopened.rebuildIndex();
  const s = await reopened.getSettings();
  assert.deepStrictEqual(s.assistants.map((a) => a.id), ['mine']);
  assert.strictEqual(s.pals, undefined);
  const chat = await reopened.getChat('old-1');
  assert.strictEqual(chat.assistantId, 'mine');
  assert.strictEqual(chat.palId, undefined);
  assert.strictEqual((await reopened.listChats())[0].assistantId, 'mine');

  // importing an old backup file
  const other = (await tmpStorage()).storage;
  await other.importAll({ app: 'pal', chats: [{ id: 'b1', title: 'From backup', palId: 'writer', messages: [] }] });
  assert.strictEqual((await other.getChat('b1')).assistantId, 'writer');
  void storage;
});

test('recall finds relevant parts of earlier chats', async () => {
  const { storage } = await tmpStorage();
  const add = async (title, pairs) => {
    const chat = await storage.createChat({ title });
    for (const [role, content] of pairs) chat.messages.push({ id: `${role}${Math.random()}`, role, content });
    return storage.saveChat(chat);
  };
  const trip = await add('Weekend trip', [
    ['user', 'Plan a weekend in AlUla for my family'],
    ['assistant', '<think>they want a plan</think>Stay at the Habitas AlUla resort, visit Hegra and Elephant Rock.']
  ]);
  await add('Email', [['user', 'Write a budget email to my manager'], ['assistant', 'Here is the budget email draft.']]);
  const food = await add('طبخ', [['user', 'أعطني وصفة الكبسة باللحم'], ['assistant', 'وصفة الكبسة: أرز بسمتي ولحم وبهارات.']]);
  const current = await add('Now', [['user', 'Which AlUla resort did we pick?']]);

  const hits = await storage.recall('Which resort in AlUla did we pick?', { excludeId: current.id });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].chatId, trip.id);
  assert.match(hits[0].text, /Habitas AlUla resort/);
  assert.ok(!hits[0].text.includes('<think>'), 'thinking is left out');

  const ar = await storage.recall('كيف أطبخ الكبسة؟ أريد الوصفة');
  assert.strictEqual(ar[0].chatId, food.id);

  assert.deepStrictEqual(await storage.recall('quantum physics homework'), []);
  assert.deepStrictEqual(await storage.recall('tell me'), []);

  // Edited chats are read again.
  const again = await storage.getChat(trip.id);
  again.messages.push({ id: 'u9', role: 'user', content: 'Change the AlUla resort to Banyan Tree' });
  await storage.saveChat(again);
  const hits2 = await storage.recall('AlUla resort Banyan', { excludeId: current.id });
  assert.match(hits2[0].text, /Banyan Tree/);

  // Stays within the size budget.
  const small = await storage.recall('AlUla resort Hegra', { maxChars: 150 });
  assert.ok(small.reduce((n, h) => n + h.text.length, 0) <= 150);
});

test('importing a backup merges a chat that is still on this device (nothing added since is lost)', async () => {
  const storage = await Storage.open(nodeFsBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'balimda-import-'))));
  const chat = await storage.createChat({ title: 'Trip' });
  chat.messages.push({ id: 'a', role: 'user', content: 'Plan my trip', createdAt: 1 });
  await storage.saveChat(chat);
  const backup = JSON.parse(JSON.stringify(await storage.exportAll()));
  const now = await storage.getChat(chat.id);
  now.messages.push({ id: 'b', role: 'assistant', content: 'Here is a plan', createdAt: 2 });
  await storage.saveChat(now);
  assert.strictEqual(await storage.importAll(backup), 1);
  const after = await storage.getChat(chat.id);
  assert.deepStrictEqual(after.messages.map((m) => m.id), ['a', 'b']);
});
