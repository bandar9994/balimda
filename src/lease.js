// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

// Who is writing a reply. A reply still being written carries
//
//   owner: { deviceId, name, ts }
//
// where `ts` is refreshed while the reply streams. Another device that finds
// the chat (through sync) while the lease is live must not treat the reply as
// cut off: it shows "Replying on <name>…" and leaves it alone. Once the lease
// has gone stale the reply counts as interrupted, as it always did for chats
// without an owner. The owner is dropped when the reply ends.
//
// Used by the sync merge (src/sync.js), the desktop app's reply bookkeeping
// (src/reply-hub.js) and the UI (renderer/app.js, loaded as window.Lease).

(function (root) {
  'use strict';

  // How long a lease counts as live without a refresh. The owner refreshes it
  // every HEARTBEAT_MS, but another device only sees the refresh after it has
  // synced (a push is at most every ~20 s, and the other device looks every
  // ~20 s), so this has to be well above the ~40 s that adds up to.
  const LEASE_MS = 90 * 1000;
  const HEARTBEAT_MS = 10 * 1000;
  // A lease dated further ahead than this (the owner's clock is wrong by more
  // than the sync protocol itself tolerates) is not trusted either.
  const SKEW_MS = 5 * 60 * 1000;

  const leaseLive = (owner, now = Date.now()) => !!owner && typeof owner === 'object'
    && Number.isFinite(owner.ts) && now - owner.ts <= LEASE_MS && owner.ts - now <= SKEW_MS;

  // The reply is still being written by a device whose lease is live.
  const liveReply = (msg, now = Date.now()) => !!msg && !!msg.pending && leaseLive(msg.owner, now);

  // The reply is being written by some other device than `deviceId`.
  const foreignReply = (msg, deviceId, now = Date.now()) => liveReply(msg, now)
    && !!msg.owner.deviceId && msg.owner.deviceId !== deviceId;

  // A reply that is being written right now, on any device, as far as the
  // lease says: still pending and its owner refreshed it recently. This is the
  // one question the busy state of a chat is drawn from, so a reply nobody is
  // writing any more stops showing as in progress once the lease runs out.
  const isReplyInProgress = liveReply;

  // The first reply in a chat that is in progress.
  const replyInProgress = (chat, now = Date.now()) => (chat && chat.messages || []).find((m) => liveReply(m, now)) || null;

  const newOwner = (deviceId, name, now = Date.now()) => ({ deviceId: String(deviceId), name: String(name || 'another device').slice(0, 60), ts: now });

  // Refresh the lease of a reply this device is writing.
  function touch(msg, now = Date.now()) {
    if (msg && msg.owner) msg.owner.ts = now;
    return msg;
  }

  // What a reply that was cut off after it had text says, so it never looks finished.
  const INTERRUPTED_NOTICE = 'This reply stopped before it was finished: the device writing it went quiet. Tap Regenerate to ask again.';
  // ...and what one that was cut off before any text says.
  const INTERRUPTED_ERROR = 'This reply was interrupted.';

  // A reply that is still marked as being written but isn't (any more): ends
  // it the way a reply cut off by closing the app always ended, flags it
  // when it had an owner, so a copy that finished elsewhere replaces it, and
  // says so when it had text (it must not look like a finished reply).
  function interrupt(msg) {
    msg.pending = false;
    if (!msg.content) msg.error = INTERRUPTED_ERROR;
    else if (!msg.notice) msg.notice = INTERRUPTED_NOTICE;
    if (msg.owner) {
      msg.interrupted = true;
      delete msg.owner;
    }
    return msg;
  }

  // The first chat in a list with a reply being written on another device.
  const foreignInChat = (chat, deviceId, now = Date.now()) => (chat && chat.messages || []).find((m) => foreignReply(m, deviceId, now)) || null;

  // Which device is actually generating a reply. The owner is the device that
  // holds the lease, and that is the device that asked: a computer writing a
  // reply for a phone keeps the phone as owner (see reply-hub.js), so the
  // owner alone would say the phone is writing a reply the computer writes.
  // The reply's model says where it runs when it is a computer's model
  // ("name (Computer, Label)"). Nothing is stored for this: it is worked out
  // when the line is drawn, from what every device already has.
  //
  //   me = { deviceId, name, computers }  this device; computers = settings.computers
  //
  // Returns { name, here, askedFrom }: the device that runs it, whether that is
  // this device, and (when it is this device but another one asked) who asked.
  function runningOn(msg, me = {}) {
    const owner = (msg && msg.owner) || {};
    const model = msg && msg.model && msg.model.provider === 'computer' && typeof msg.model.model === 'string' ? msg.model.model : '';
    let host = null;
    if (model) {
      const known = Object.entries(me.computers || {})
        .filter(([, c]) => c && typeof c.name === 'string' && c.name)
        .sort((a, b) => b[1].name.length - a[1].name.length)
        .find(([, c]) => model.includes(` (${c.name},`) || model.endsWith(` (${c.name})`));
      if (known) host = { id: known[0], name: known[1].name };
      else {
        const m = /\(([^(),]+)(?:,[^()]*)?\)$/.exec(model);
        if (m && m[1].trim()) host = { id: null, name: m[1].trim() };
      }
    }
    if (!host) {
      const here = !!owner.deviceId && owner.deviceId === me.deviceId;
      return { name: owner.name || 'another device', here, askedFrom: null };
    }
    const here = (!!host.id && host.id === me.deviceId) || (!!me.name && host.name === me.name);
    const asked = here && owner.deviceId && owner.deviceId !== me.deviceId ? (owner.name || null) : null;
    return { name: here ? (me.name || host.name) : host.name, here, askedFrom: asked };
  }

  // A copy of a chat about to be saved over the stored one, from a window that
  // may be behind: replies another device owns (or that this computer wrote
  // for a phone, `mirrored`) keep their stored version when it is further on:
  // longer, or finished while the incoming copy is still being written.
  // Changes `incoming` in place and returns it.
  function keepNewerReplies(stored, incoming, deviceId) {
    if (!stored || !incoming || !Array.isArray(stored.messages) || !Array.isArray(incoming.messages)) return incoming;
    const byId = new Map(stored.messages.map((m) => [m.id, m]));
    incoming.messages = incoming.messages.map((m) => {
      const s = m && byId.get(m.id);
      if (!s || s.role !== 'assistant') return m;
      const others = s.mirrored || (s.owner && s.owner.deviceId && s.owner.deviceId !== deviceId);
      if (!others) return m;
      const longer = String(s.content || '').length > String(m.content || '').length;
      const finished = !s.pending && m.pending;
      if (!longer && !finished) return m;
      // The stored copy goes on, with the answers given in this window.
      if (!Array.isArray(m.approvals) || !Array.isArray(s.approvals)) return s;
      const answered = new Map(m.approvals.filter((a) => a.state !== 'pending' && a.state !== 'sending').map((a) => [`${a.runId}|${a.approvalId || ''}`, a.state]));
      return { ...s, approvals: s.approvals.map((a) => (a.state === 'pending' && answered.has(`${a.runId}|${a.approvalId || ''}`) ? { ...a, state: answered.get(`${a.runId}|${a.approvalId || ''}`) } : a)) };
    });
    return incoming;
  }

  // "Replying on <device>…", or just "Replying…" when this device writes it.
  function replyingLabel(msg, me = {}, lang = language()) {
    const r = runningOn(msg, me);
    if (!r.here) return text('replyingOn', r.name, lang);
    const base = text('replyingHere', null, lang);
    return r.askedFrom ? `${base} ${text('askedFrom', r.askedFrom, lang)}` : base;
  }

  // What the app says about it, in English and Arabic (the app's own text is
  // English; these two are shown in Arabic when the device is set to Arabic).
  const STRINGS = {
    en: {
      replyingOn: (name) => `Replying on ${name}…`,
      replyingHere: () => 'Replying…',
      askedFrom: (name) => `· asked from ${name}`,
      busyElsewhere: (name) => `A reply is already being written in this chat (on ${name}). Wait for it to finish, or stop it there first.`,
      stopThere: (name) => `It is running on ${name}: stop it there.`,
      stopFailed: (name) => `Couldn't stop it from here: the reply is running on ${name}. Stop it there.`,
      queued: () => 'Queued',
      removeQueued: () => 'Remove from the queue',
      busy: () => 'A reply is already being written in this chat. Wait for it to finish, or stop it first. Your message is kept.'
    },
    ar: {
      replyingOn: (name) => `${name} يكتب الرد…`,
      replyingHere: () => 'جارٍ الرد…',
      askedFrom: (name) => `· بطلب من ${name}`,
      busyElsewhere: (name) => `يوجد رد قيد الكتابة في هذه المحادثة (على ${name}). انتظر حتى ينتهي، أو أوقفه من هناك أولًا.`,
      stopThere: (name) => `الرد يعمل على ${name}، أوقفه من هناك.`,
      stopFailed: (name) => `تعذّر الإيقاف من هنا لأن الرد يعمل على ${name}. أوقفه من هناك.`,
      queued: () => 'بالانتظار',
      removeQueued: () => 'إزالة من قائمة الانتظار',
      busy: () => 'يوجد رد قيد الكتابة في هذه المحادثة. انتظر حتى ينتهي أو أوقفه أولًا، ورسالتك محفوظة.'
    }
  };
  // The app's language (Settings → General), else the device's.
  const language = () => (root.I18n ? root.I18n.lang() : typeof navigator !== 'undefined' && /^ar/i.test(navigator.language || '') ? 'ar' : 'en');
  const text = (key, name, lang = language()) => (STRINGS[lang] || STRINGS.en)[key](name || 'another device');

  const api = { text, runningOn, replyingLabel, STRINGS, LEASE_MS, HEARTBEAT_MS, SKEW_MS, INTERRUPTED_NOTICE, INTERRUPTED_ERROR, keepNewerReplies, leaseLive, liveReply, isReplyInProgress, replyInProgress, foreignReply, foreignInChat, newOwner, touch, interrupt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Lease = api;
})(typeof window !== 'undefined' ? window : globalThis);
