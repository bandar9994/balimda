// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

// "Replying on …" names the device that runs the reply, not the one that asked
// for it (Lease.runningOn / replyingLabel, drawn in renderer/app.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Lease = require('../src/lease');
const { createReplyHub } = require('../src/reply-hub');
const { Storage } = require('../src/storage');
const { nodeFsBackend } = require('../src/backends/node-fs');

const NOW = Date.now();
const PHONE = { deviceId: 'phone-1', name: 'Android phone', computers: { 'pc-1': { name: 'BandarPC', enabled: true } } };
const PC = { deviceId: 'pc-1', name: 'BandarPC', computers: { 'pc-1': { name: 'BandarPC', enabled: true } } };
const hermes = { provider: 'computer', model: 'hermes-agent (BandarPC, Hermes Agent)' };
// What the computer keeps for a phone's reply: the phone is the owner.
const mirrored = (model = hermes) => ({ id: 'r', role: 'assistant', content: 'x', pending: true, model, owner: { deviceId: 'phone-1', name: 'Android phone', ts: NOW } });

test('a phone\'s reply that runs on the computer: the phone says "on BandarPC", the computer says plain "Replying…"', () => {
  const msg = mirrored();
  assert.strictEqual(Lease.replyingLabel(msg, PHONE, 'en'), 'Replying on BandarPC…');
  assert.strictEqual(Lease.replyingLabel(msg, PC, 'en'), 'Replying… · asked from Android phone');
  assert.deepStrictEqual({ ...Lease.runningOn(msg, PHONE) }, { name: 'BandarPC', here: false, askedFrom: null });
  assert.deepStrictEqual({ ...Lease.runningOn(msg, PC) }, { name: 'BandarPC', here: true, askedFrom: 'Android phone' });
});

test('it does not matter whether the lease is live or the phone is away: the label comes from where it runs', () => {
  const old = { ...mirrored(), owner: { deviceId: 'phone-1', name: 'Android phone', ts: NOW - 60_000 } };
  assert.strictEqual(Lease.replyingLabel(old, PHONE, 'en'), 'Replying on BandarPC…');
});

test('an Ollama model on the computer (no label after the name) and a computer not in the settings are read from the model name too', () => {
  const ollama = mirrored({ provider: 'computer', model: 'qwen3:8b (BandarPC)' });
  assert.strictEqual(Lease.replyingLabel(ollama, PHONE, 'en'), 'Replying on BandarPC…');
  const nobody = { deviceId: 'phone-1', name: 'Android phone', computers: {} };
  assert.strictEqual(Lease.replyingLabel(mirrored(), nobody, 'en'), 'Replying on BandarPC…');
  // A computer with a comma in its name is found through the settings.
  const odd = { ...PC, name: 'Bandar, PC', computers: { 'pc-1': { name: 'Bandar, PC' } } };
  const msg = mirrored({ provider: 'computer', model: 'hermes-agent (Bandar, PC, Hermes Agent)' });
  assert.strictEqual(Lease.runningOn(msg, odd).here, true);
  assert.strictEqual(Lease.runningOn(msg, { ...PHONE, computers: odd.computers }).name, 'Bandar, PC');
});

test('a second computer names the computer that runs it', () => {
  const laptop = { deviceId: 'pc-2', name: 'Laptop', computers: { 'pc-1': { name: 'BandarPC' }, 'pc-2': { name: 'Laptop' } } };
  assert.strictEqual(Lease.replyingLabel(mirrored(), laptop, 'en'), 'Replying on BandarPC…');
  assert.strictEqual(Lease.runningOn(mirrored(), laptop).here, false);
});

test('replies that do not use a computer\'s model are named after their owner, as before', () => {
  const own = { id: 'r', pending: true, model: { provider: 'ollama', model: 'qwen' }, owner: { deviceId: 'phone-1', name: 'Android phone', ts: NOW } };
  assert.strictEqual(Lease.replyingLabel(own, PC, 'en'), 'Replying on Android phone…');
  assert.deepStrictEqual({ ...Lease.runningOn(own, PHONE) }, { name: 'Android phone', here: true, askedFrom: null });
  assert.strictEqual(Lease.replyingLabel(own, PHONE, 'en'), 'Replying…', 'a device that runs it says nothing about a device');
  const noModel = { id: 'r', pending: true, owner: { deviceId: 'pc-1', name: 'BandarPC', ts: NOW } };
  assert.strictEqual(Lease.replyingLabel(noModel, PHONE, 'en'), 'Replying on BandarPC…');
  // No owner at all: still a name.
  assert.strictEqual(Lease.runningOn({ id: 'r' }, PHONE).name, 'another device');
});

test('the Arabic text is there for both new lines', () => {
  assert.match(Lease.replyingLabel(mirrored(), PHONE, 'ar'), /BandarPC/);
  assert.match(Lease.replyingLabel(mirrored(), PC, 'ar'), /^جارٍ الرد… · بطلب من Android phone$/);
  assert.strictEqual(Lease.text('replyingHere', null, 'en'), 'Replying…');
  for (const key of Object.keys(Lease.STRINGS.en)) assert.ok(Lease.STRINGS.ar[key], `Arabic text for ${key}`);
});

test('the real copy the computer writes for a phone reads right on both devices, and the owner is left alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najwa-host-'));
  const storage = await Storage.open(nodeFsBackend(dir));
  const made = await storage.createChat({ title: 'Game' });
  await storage.saveChat({ ...made, messages: [{ id: 'q', role: 'user', content: 'hi', createdAt: 1 }] });
  const h = createReplyHub({ storage, name: () => 'BandarPC', flushMs: 10, heartbeatMs: 20 });
  const req = { chatId: made.id, deviceId: 'phone-1', deviceName: 'Android phone', reply: { id: 'r1', at: 1000, model: hermes }, req: { model: hermes.model } };
  await h.remoteChat(req, { emit() {} }, async (onDelta) => {
    onDelta('Working on it');
    await new Promise((r) => setTimeout(r, 80));
    const c = await storage.getChat(made.id);
    const m = c.messages.at(-1);
    // The lease keeps the phone as owner (merging and Stop depend on it) ...
    assert.strictEqual(m.owner.deviceId, 'phone-1');
    // ... and both devices say where it runs.
    assert.strictEqual(Lease.replyingLabel(m, PHONE, 'en'), 'Replying on BandarPC…');
    assert.strictEqual(Lease.replyingLabel(m, PC, 'en'), 'Replying… · asked from Android phone');
    return { text: 'Working on it' };
  });
});

test('the app draws the label, hint, Stop and toasts from where the reply runs', () => {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  assert.doesNotMatch(src, /Lease\.text\('replyingOn', [a-z.]*owner\.name\)/, 'no label is made from the owner any more');
  assert.match(src, /text: replyLabel\(msg\)/);
  assert.match(src, /canStopElsewhere = .*replyHost\(msg\)\.here/, 'Stop from a computer only for a reply that runs on it');
  assert.doesNotMatch(src, /Lease\.text\('(busyElsewhere|stopFailed|stopThere)', [a-z.]*owner\.name\)/);
});

// ---- resume after sync: the phone restores the indicator from the synced owner ----------

const vm = require('node:vm');
const appSrc = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const slice = (head) => {
  const start = appSrc.indexOf(head);
  assert.ok(start >= 0, head);
  const end = head.startsWith('function') ? appSrc.indexOf('\n}\n', start) + 3 : appSrc.indexOf('\n', start) + 1;
  return appSrc.slice(start, end);
};
const pieces = ['function isStreaming(', 'const myDeviceId = ', 'const myDeviceName = ', 'const replyElsewhere = ', 'const replyHost = ', 'const replyLabel = ',
  'function runsHere(', 'const canStopElsewhere = ', 'const APP_STARTED = ', 'function watchedReply(', 'const isAgent = ', 'function midReplyAction('].map(slice).join('\n');

function device(me, { stopElsewhere = true } = {}) {
  const ctx = {
    Lease, Date,
    S: { requests: new Map(), info: { deviceId: me.deviceId, deviceName: me.name }, state: {}, settings: { computers: me.computers }, current: null },
    api: { ai: stopElsewhere ? { stopElsewhere() {} } : {} }
  };
  vm.createContext(ctx);
  vm.runInContext(`${pieces}; this.fns = { replyElsewhere, replyHost, replyLabel, runsHere, canStopElsewhere, watchedReply, midReplyAction };`, ctx);
  return ctx;
}

test('resume after sync: the phone, back from the lock screen, finds the computer\'s copy with itself as owner and still names the computer', () => {
  const phone = device(PHONE, { stopElsewhere: false });
  const synced = { id: 'c', messages: [{ id: 'q', role: 'user', content: 'hi' }, mirrored()] };
  const msg = synced.messages[1];
  msg.owner.ts = Date.now() + 1;   // refreshed by the computer after this app started
  const f = phone.fns;
  // The phone's own request is gone (the app was away), only the synced copy is left.
  assert.strictEqual(f.runsHere(msg), false);
  assert.strictEqual(f.watchedReply(msg, Date.now()), true, 'the indicator is restored');
  assert.strictEqual(f.replyElsewhere(synced), msg);
  const host = f.replyHost(msg);
  assert.strictEqual(host.here, false, 'the phone does not take itself for the one that runs it');
  assert.strictEqual(host.name, 'BandarPC');
  assert.strictEqual(f.replyLabel(msg), 'Replying on BandarPC…');
  assert.strictEqual(f.canStopElsewhere(msg), false, 'no local stop of a reply on the computer');
  assert.strictEqual(f.midReplyAction(msg.model), 'queue', 'a message sent now waits instead of steering');
});

test('resume after sync: the computer shows plain "Replying…" and can stop the job it holds', () => {
  const pc = device(PC);
  const msg = mirrored();
  assert.strictEqual(pc.fns.replyLabel(msg), 'Replying… · asked from Android phone');
  assert.strictEqual(pc.fns.replyHost(msg).here, true);
  assert.strictEqual(pc.fns.canStopElsewhere(msg), true);
  // A reply that runs on another computer cannot be stopped from here.
  const other = device({ deviceId: 'pc-2', name: 'Laptop', computers: PC.computers });
  assert.strictEqual(other.fns.canStopElsewhere(msg), false);
  assert.strictEqual(other.fns.replyLabel(msg), 'Replying on BandarPC…');
});
