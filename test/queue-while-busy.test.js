// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

// Messages sent while a reply runs: which ones steer the reply, which stop it
// and continue, and which wait in the queue, one at a time and in order. This
// runs the real functions from renderer/app.js against small fakes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const Lease = require('../src/lease.js');
const take = (head) => {
  const start = src.indexOf(head);
  assert.ok(start >= 0, head);
  const end = head === 'const queued = {' ? src.indexOf('\n};\n', start) + 4 : head === 'const alreadySent = ' ? src.indexOf(');\n', start) + 3 : head.startsWith('const') || head.startsWith('let') ? src.indexOf('\n', start) + 1 : src.indexOf('\n}\n', start) + 3;
  return src.slice(start, end);
};
const parts = [
  'const isAgent = ',
  'const queuedByChat = ', 'const queued = {', 'const inflightQueued = ', 'const MAX_QUEUED = ', 'const MAX_QUEUED_CHATS = ', 'const MAX_QUEUED_TEXT = ', 'const queueEntry = ', 'const hasAttachments = ',
  'function queueSnapshot(', 'function readQueue(', 'let queueSaved = ', 'function persistQueue(', 'function restoreQueue(', 'const alreadySent = ', 'function dropQueue(', 'function acceptQueued(', 'const retryAt = ', 'const fromQueue = ',
  'function interruptFor(', 'function midReplyAction(', 'async function sendWhileReplying(',
  'function canSendQueued(', 'function sendQueued(', 'function flushQueued(', 'function flushAllQueued('
].map(take).join('\n');

function world({ model, steerTakes = false, elsewhere = null } = {}) {
  const chat = { id: 'c1', messages: [{ id: 'u0', role: 'user', content: 'first' }] };
  const log = { steered: [], aborted: [], runs: 0, putBack: [], toasts: [], warns: [], saved: [] };
  const S = { requests: new Map(), cache: new Map([['c1', chat]]), current: chat };
  const ctx = {
    S, Lease, log, elsewhere: () => ctx.__elsewhere,
    __elsewhere: elsewhere,
    isStreaming: (c) => [...S.requests.values()].some((r) => r.chat === c),
    replyElsewhere: () => ctx.__elsewhere,
    uid: (() => { let n = 0; return () => `id${++n}`; })(),
    scheduleMessageRender() {}, saveChatSoon() {}, drawQueued() {},
    putBack: (c, list) => log.putBack.push(list),
    toast: (t) => log.toasts.push(t),
    chatModel: () => ctx.__model, __model: { provider: 'ollama', model: 'x' }, console: { warn: (m) => log.warns.push(m) },
    loadChat: async () => null,
    runCompletion: (c) => { log.runs++; ctx.S.requests.set(`r${log.runs}`, { chat: c, msg: { model: ctx.model } }); },
    api: { state: { save: async (p) => { log.saved.push(p); } }, ai: { steer: async (id, text) => { log.steered.push(text); return steerTakes; }, abort: (id) => log.aborted.push(id) } },
    model, Date, WeakMap, Map
  };
  vm.createContext(ctx);
  vm.runInContext(`${parts}; this.fns = { queueSnapshot, readQueue, restoreQueue, persistQueue, alreadySent, dropQueue, acceptQueued, inflightQueued, queuedByChat, midReplyAction, sendWhileReplying, sendQueued, flushQueued, flushAllQueued, queued, retryAt, fromQueue, interruptFor };`, ctx);
  const startReply = (m = model) => ctx.S.requests.set('live', { chat, msg: { model: m, tools: [] } });
  return { ctx, chat, log, S, fns: ctx.fns, startReply };
}

const provider = (p, model = 'x') => ({ provider: p, model });

test('who steers and who queues', () => {
  const { fns } = world();
  for (const m of [provider('ollama'), provider('lmstudio'), provider('onDevice'), provider('anthropic'), provider('openai')]) {
    assert.strictEqual(fns.midReplyAction(m), 'steer', m.provider);
  }
  assert.strictEqual(fns.midReplyAction(provider('hermes')), 'queue');
  assert.strictEqual(fns.midReplyAction(provider('computer', 'qwen (Mac, Hermes Agent)')), 'queue');
  assert.strictEqual(fns.midReplyAction(provider('computer', 'qwen')), 'queue', 'the phone cannot hand a message to a reply on the computer');
});

test('a reply working with tools reads the message after its step, nothing stops', async () => {
  const w = world({ model: provider('anthropic'), steerTakes: true });
  w.startReply();
  await w.fns.sendWhileReplying(w.chat, 'also check pricing', []);
  assert.deepStrictEqual(w.log.steered, ['also check pricing']);
  assert.deepStrictEqual(w.log.aborted, []);
  assert.strictEqual((w.fns.queued.get(w.chat) || []).length, 0);
  const step = w.S.requests.get('live').msg.tools[0];
  assert.strictEqual(step.status, 'sent');
});

test('plain streaming: the reply is stopped and kept, and the message goes next', async () => {
  const w = world({ model: provider('ollama'), steerTakes: false });
  w.startReply();
  await w.fns.sendWhileReplying(w.chat, 'actually, shorter please', []);
  assert.deepStrictEqual(w.log.aborted, ['live']);
  const r = w.S.requests.get('live');
  assert.strictEqual(r.interrupted, true);
  assert.strictEqual(r.stopped, true);
  assert.strictEqual(w.fns.queued.get(w.chat).length, 1);
  assert.strictEqual(r.msg.tools.length, 0, 'no leftover "sending" step');
  // The stopped reply ends like runCompletion does for an interrupted one: the message goes.
  w.S.requests.delete('live');
  w.fns.sendQueued(w.chat, { ok: true });
  assert.strictEqual(w.log.runs, 1);
  assert.strictEqual(w.chat.messages.at(-1).content, 'actually, shorter please');
});

test('a message with a picture cannot be read mid-way: it stops the reply and goes next', async () => {
  const w = world({ model: provider('anthropic'), steerTakes: true });
  w.startReply();
  await w.fns.sendWhileReplying(w.chat, 'look', ['data:image/jpeg;base64,xx']);
  assert.deepStrictEqual(w.log.steered, []);
  assert.deepStrictEqual(w.log.aborted, ['live']);
});

test('Hermes Agent and a computer\'s models: the message waits, the reply is not touched', async () => {
  for (const m of [provider('hermes'), provider('computer', 'qwen')]) {
    const w = world({ model: m, steerTakes: true });
    w.startReply();
    await w.fns.sendWhileReplying(w.chat, 'later', []);
    assert.deepStrictEqual(w.log.steered, []);
    assert.deepStrictEqual(w.log.aborted, []);
    assert.strictEqual(w.fns.queued.get(w.chat).length, 1);
  }
});

test('the queue sends one message at a time, in order, after each reply', () => {
  const w = world({ model: provider('hermes') });
  w.fns.queued.set(w.chat, [{ text: 'one', images: [] }, { text: 'two', images: [] }, { text: 'three', images: [] }]);
  w.fns.sendQueued(w.chat, { ok: true });
  assert.strictEqual(w.log.runs, 1);
  assert.strictEqual(w.chat.messages.at(-1).content, 'one');
  assert.strictEqual(w.fns.queued.get(w.chat).length, 2);
  w.fns.sendQueued(w.chat, { ok: true }); // reply 1 is still running: waits
  assert.strictEqual(w.log.runs, 1);
  w.S.requests.clear();
  w.fns.sendQueued(w.chat, { ok: true });
  assert.strictEqual(w.chat.messages.at(-1).content, 'two');
  w.S.requests.clear();
  w.fns.sendQueued(w.chat, { ok: true });
  assert.strictEqual(w.chat.messages.at(-1).content, 'three');
  assert.strictEqual(w.fns.queued.get(w.chat), undefined);
});

test('Stop keeps the queue going; a failed reply puts the messages back in the box', () => {
  const stopped = world({ model: provider('ollama') });
  stopped.fns.queued.set(stopped.chat, [{ text: 'next', images: [] }]);
  stopped.fns.sendQueued(stopped.chat, { ok: true, aborted: true });
  assert.strictEqual(stopped.log.runs, 1);
  const failed = world({ model: provider('ollama') });
  failed.fns.queued.set(failed.chat, [{ text: 'next', images: [] }]);
  failed.fns.sendQueued(failed.chat, { ok: false, error: 'boom' });
  assert.strictEqual(failed.log.runs, 0);
  assert.strictEqual(failed.log.putBack.length, 1);
});

test('while another device writes the reply nothing is sent, and it goes once the lease is gone', () => {
  const w = world({ model: provider('ollama'), elsewhere: { owner: { name: 'PC' } } });
  w.fns.queued.set(w.chat, [{ text: 'wait', images: [] }]);
  w.fns.flushQueued(w.chat);
  w.fns.sendQueued(w.chat, { ok: true });
  assert.strictEqual(w.log.runs, 0, 'no request that would come back busy');
  assert.strictEqual(w.fns.queued.get(w.chat).length, 1);
  w.ctx.__elsewhere = null; // the reply ended, or its lease ran out
  w.fns.flushQueued(w.chat);
  assert.strictEqual(w.log.runs, 1);
  assert.strictEqual(w.chat.messages.at(-1).content, 'wait');
});

test('a message the computer still refused stays queued and is not tried again at once', () => {
  const w = world({ model: provider('computer', 'qwen') });
  const entry = { text: 'again', images: [] };
  w.fns.retryAt.set('c1', Date.now() + 5000);
  w.fns.queued.set(w.chat, [entry]);
  w.fns.flushQueued(w.chat);
  assert.strictEqual(w.log.runs, 0);
  w.fns.retryAt.set('c1', Date.now() - 1);
  w.fns.flushQueued(w.chat);
  assert.strictEqual(w.log.runs, 1);
  assert.strictEqual(w.fns.fromQueue.get(w.chat.messages.at(-1)), entry);
});

test('the busy answer puts a queued message back at the front (source)', () => {
  assert.match(src, /const entry = fromQueue\.get\(asker\);[\s\S]*?queued\.set\(chat, \[entry, \.\.\.\(queued\.get\(chat\) \|\| \[\]\)\]\);[\s\S]*?retryAt\.set\(chat\.id, Date\.now\(\) \+ 5000\)/);
});

test('queue strings exist in English and Arabic, and the queued bubble is RTL-safe', () => {
  for (const lang of ['en', 'ar']) {
    assert.ok(Lease.text('queued', '', lang));
    assert.ok(Lease.text('removeQueued', '', lang));
  }
  const css = fs.readFileSync(path.join(__dirname, '../renderer/styles.css'), 'utf8');
  const rule = css.match(/\.queued-item \{[^}]*\}/)[0];
  assert.doesNotMatch(rule, /padding-(left|right)|margin-(left|right)/);
  assert.match(src, /class: 'queued-text', dir: 'auto'/);
});

// ---- the queue survives closing the app ---------------------------------------------

const plain = (x) => JSON.parse(JSON.stringify(x));
const lastSaved = (w) => plain(w.log.saved.at(-1));

test('every change to the queue is written to the local state, text only, and pictures stay in memory', async () => {
  const w = world({ model: provider('hermes') });
  w.startReply();
  await w.fns.sendWhileReplying(w.chat, 'one', []);
  await w.fns.sendWhileReplying(w.chat, 'two', []);
  await w.fns.sendWhileReplying(w.chat, 'with a picture', ['data:image/jpeg;base64,xx']);
  const saved = lastSaved(w).sendQueue;
  assert.deepStrictEqual(Object.keys(saved), ['c1']);
  assert.deepStrictEqual(plain(saved.c1.map((q) => q.text)), ['one', 'two'], 'the picture message is not written');
  for (const q of saved.c1) {
    assert.deepStrictEqual(Object.keys(q).sort(), ['createdAt', 'id', 'text'], 'only what is needed to send');
    assert.ok(q.id && Number.isFinite(q.createdAt));
  }
  assert.strictEqual(w.fns.queued.get(w.chat).length, 3, 'it is still queued in memory');
  // Removing one (the x) updates the file.
  const list = w.fns.queued.get(w.chat);
  list.splice(0, 1);
  w.fns.queued.set(w.chat, list);
  assert.deepStrictEqual(plain(lastSaved(w).sendQueue.c1.map((q) => q.text)), ['two']);
  w.fns.queued.delete(w.chat);
  assert.deepStrictEqual(lastSaved(w).sendQueue, {});
});

test('a message leaves the disk only after the send is accepted, and a refused one stays', () => {
  const w = world({ model: provider('ollama') });
  w.fns.queued.set(w.chat, [{ id: 'a', text: 'one', images: [], createdAt: 1 }, { id: 'b', text: 'two', images: [], createdAt: 2 }]);
  w.fns.sendQueued(w.chat, { ok: true });
  // Sending: "one" is on its way but still on disk, with "two".
  assert.deepStrictEqual(plain(lastSaved(w).sendQueue.c1.map((q) => q.id)), ['a', 'b']);
  assert.strictEqual(w.fns.inflightQueued.get('c1').id, 'a');
  w.fns.acceptQueued(w.chat, w.fns.inflightQueued.get('c1')); // saved in the chat
  assert.deepStrictEqual(plain(lastSaved(w).sendQueue.c1.map((q) => q.id)), ['b']);
});

test('at start the queues come back, in order, for chats that still exist; a deleted chat\'s are dropped', () => {
  const w = world({ model: provider('ollama') });
  const raw = {
    c1: [{ id: 'a', text: 'one', createdAt: 1 }, { id: 'b', text: 'two', createdAt: 2 }],
    gone: [{ id: 'z', text: 'lost chat', createdAt: 3 }]
  };
  w.fns.restoreQueue(raw, new Set(['c1']));
  assert.deepStrictEqual(plain(w.fns.queued.get(w.chat).map((q) => q.text)), ['one', 'two']);
  assert.strictEqual(w.fns.queuedByChat.has('gone'), false);
  assert.deepStrictEqual(Object.keys(lastSaved(w).sendQueue), ['c1'], 'the deleted chat is cleared from the file');
  // They go under the usual rules: one at a time.
  w.fns.flushQueued(w.chat);
  assert.strictEqual(w.chat.messages.at(-1).content, 'one');
  assert.strictEqual(w.log.runs, 1);
});

test('restored messages wait while another device owns the reply, and for a model', () => {
  const w = world({ model: provider('ollama'), elsewhere: { owner: { name: 'PC' } } });
  w.fns.restoreQueue({ c1: [{ id: 'a', text: 'wait', createdAt: 1 }] }, new Set(['c1']));
  w.fns.flushQueued(w.chat);
  assert.strictEqual(w.log.runs, 0);
  w.ctx.__elsewhere = null;
  w.ctx.__model = null; // models not loaded yet
  w.fns.flushQueued(w.chat);
  assert.strictEqual(w.log.runs, 0);
  w.ctx.__model = { provider: 'ollama', model: 'x' };
  w.fns.flushQueued(w.chat);
  assert.strictEqual(w.log.runs, 1);
});

test('a message that went out just before the app closed is not sent twice', () => {
  const w = world({ model: provider('ollama') });
  w.chat.messages.push({ id: 'u1', role: 'user', content: 'one', createdAt: 5 });
  w.fns.restoreQueue({ c1: [{ id: 'a', text: 'one', createdAt: 4 }, { id: 'b', text: 'two', createdAt: 6 }] }, new Set(['c1']));
  w.fns.flushQueued(w.chat);
  assert.strictEqual(w.log.runs, 1);
  assert.strictEqual(w.chat.messages.at(-1).content, 'two', '"one" is already in the chat');
  assert.strictEqual(w.chat.messages.filter((m) => m.content === 'one').length, 1);
});

test('damaged storage is cleared with a warning; bad items are dropped, good ones kept', () => {
  for (const raw of ['junk', 42, [1, 2]]) {
    const w = world({ model: provider('ollama') });
    w.fns.restoreQueue(raw, new Set(['c1']));
    assert.strictEqual(w.fns.queuedByChat.size, 0);
    assert.strictEqual(w.log.warns.length, 1, `warns for ${JSON.stringify(raw)}`);
    assert.deepStrictEqual(lastSaved(w).sendQueue, {}, 'cleared on disk');
  }
  const w = world({ model: provider('ollama') });
  w.fns.restoreQueue({ c1: [{ id: 'a', text: 'ok', createdAt: 1 }, { id: 'a', text: 'dup', createdAt: 2 }, { text: 'no id', createdAt: 3 }, null, { id: 'e', text: '', createdAt: 1 }], c2: 'nope' }, new Set(['c1', 'c2']));
  assert.deepStrictEqual(plain(w.fns.queued.get(w.chat).map((q) => q.text)), ['ok']);
  assert.strictEqual(w.log.warns.length, 1);
});

test('the saved queue is capped', () => {
  const w = world({ model: provider('ollama') });
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `i${i}`, text: 'x'.repeat(30000), createdAt: i + 1 }));
  w.fns.restoreQueue({ c1: many }, new Set(['c1']));
  assert.strictEqual(w.fns.queued.get(w.chat).length, 20);
  assert.strictEqual(w.fns.queued.get(w.chat)[0].text.length, 20000);
  const byChat = new Map(Array.from({ length: 80 }, (_, i) => [`chat${i}`, [{ id: `q${i}`, text: 't', images: [], createdAt: 1 }]]));
  assert.ok(Object.keys(w.fns.queueSnapshot(byChat, new Map())).length <= 50);
});

test('deleting a chat clears its waiting messages from the file', async () => {
  const w = world({ model: provider('hermes') });
  w.startReply();
  await w.fns.sendWhileReplying(w.chat, 'one', []);
  w.fns.dropQueue('c1');
  assert.deepStrictEqual(lastSaved(w).sendQueue, {});
  assert.strictEqual(w.fns.queuedByChat.has('c1'), false);
});

test('the queue is kept only in state.json (local), restored at start, and never in a chat or in sync', () => {
  assert.match(src, /api\.state\.save\(\{ sendQueue: /);
  assert.match(src, /restoreQueue\(S\.state\.sendQueue, new Set\(S\.chats\.map/);
  assert.match(src, /flushAllQueued\(\);\n\}\n\ninit\(\);/);
  const syncSrc = fs.readFileSync(path.join(__dirname, '../src/sync.js'), 'utf8');
  assert.doesNotMatch(syncSrc, /sendQueue|(?<!sync-)state\.json/, 'the sync never reads the local state file');
});
