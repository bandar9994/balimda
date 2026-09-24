const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../src/storage');

function tmpStorage(secrets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-test-'));
  return { dir, storage: new Storage(dir, secrets) };
}

test('chats persist across restarts', () => {
  const { dir, storage } = tmpStorage();
  const chat = storage.createChat({ palId: 'default', model: { provider: 'ollama', model: 'llama3.2' } });
  chat.title = 'Trip planning';
  chat.messages.push({ id: 'm1', role: 'user', content: 'Plan a trip to Riyadh' });
  storage.saveChat(chat);

  const reopened = new Storage(dir);
  const list = reopened.listChats();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].title, 'Trip planning');
  assert.strictEqual(list[0].preview, 'Plan a trip to Riyadh');
  assert.deepStrictEqual(reopened.getChat(chat.id).messages[0].content, 'Plan a trip to Riyadh');
});

test('index is rebuilt when missing', () => {
  const { dir, storage } = tmpStorage();
  storage.createChat({ title: 'A' });
  storage.createChat({ title: 'B' });
  fs.unlinkSync(path.join(dir, 'index.json'));
  assert.strictEqual(new Storage(dir).listChats().length, 2);
});

test('pinned chats sort first, then most recent', () => {
  const { storage } = tmpStorage();
  const a = storage.createChat({ title: 'old pinned' });
  a.pinned = true;
  a.updatedAt = 1;
  storage.saveChat(a);
  const b = storage.createChat({ title: 'new' });
  b.updatedAt = 100;
  storage.saveChat(b);
  const c = storage.createChat({ title: 'older' });
  c.updatedAt = 50;
  storage.saveChat(c);
  assert.deepStrictEqual(storage.listChats().map((x) => x.title), ['old pinned', 'new', 'older']);
});

test('search finds text inside messages', () => {
  const { storage } = tmpStorage();
  const chat = storage.createChat({ title: 'Recipes' });
  chat.messages.push({ role: 'assistant', content: 'Kabsa uses rice, chicken and baharat spices.' });
  storage.saveChat(chat);
  storage.createChat({ title: 'Other' });
  const hits = storage.searchChats('baharat');
  assert.strictEqual(hits.length, 1);
  assert.match(hits[0].preview, /baharat/);
  assert.strictEqual(storage.searchChats('recipes').length, 1);
});

test('delete removes chat file and index entry', () => {
  const { dir, storage } = tmpStorage();
  const chat = storage.createChat();
  storage.deleteChat(chat.id);
  assert.strictEqual(storage.listChats().length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'chats', `${chat.id}.json`)));
});

test('rejects path traversal ids', () => {
  const { storage } = tmpStorage();
  assert.throws(() => storage.getChat('../settings'));
});

test('export and import round trip', () => {
  const { storage } = tmpStorage();
  const chat = storage.createChat({ title: 'Keep me' });
  chat.messages.push({ role: 'user', content: 'hi' });
  storage.saveChat(chat);
  const backup = storage.exportAll();

  const other = tmpStorage().storage;
  assert.strictEqual(other.importAll(backup), 1);
  assert.strictEqual(other.listChats()[0].title, 'Keep me');
});

test('settings merge with defaults and encrypt api keys', () => {
  const secrets = { encrypt: (s) => `x:${s}`, decrypt: (s) => s.replace(/^x:/, '') };
  const { dir, storage } = tmpStorage(secrets);
  const s = storage.getSettings();
  assert.strictEqual(s.providers.ollama.baseUrl, 'http://127.0.0.1:11434');
  s.providers.anthropic.apiKey = 'sk-secret';
  s.memory = 'I like tea';
  storage.saveSettings(s);

  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.strictEqual(raw.providers.anthropic.apiKey, 'x:sk-secret');
  const again = storage.getSettings();
  assert.strictEqual(again.providers.anthropic.apiKey, 'sk-secret');
  assert.strictEqual(again.memory, 'I like tea');
});

test('app state is remembered', () => {
  const { dir, storage } = tmpStorage();
  storage.saveState({ lastChatId: 'abc', drafts: { abc: 'half typed' } });
  storage.saveState({ sidebarCollapsed: true });
  const state = new Storage(dir).getState();
  assert.deepStrictEqual(state, { lastChatId: 'abc', drafts: { abc: 'half typed' }, sidebarCollapsed: true });
});

test('preview hides reasoning blocks', () => {
  const { storage } = tmpStorage();
  const chat = storage.createChat();
  chat.messages.push({ role: 'assistant', content: '<think>secret plan</think>\n\n**Final**   answer' });
  storage.saveChat(chat);
  assert.strictEqual(storage.listChats()[0].preview, 'Final answer');
});
