// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

// The computer's bookkeeping for replies, in the desktop app's main process:
//
//  * One reply at a time per chat. A chat's reply is "claimed" while it is
//    written, by the window or by a phone using this computer's models; a
//    second claim on the same chat (from any device, this one included) is
//    refused with a `busy` error instead of two models writing into one chat.
//  * Replies written for the phone are also written into this computer's own
//    copy of the chat as they stream, with the phone's message id and the
//    phone as owner (see lease.js), then finished and synced. Closing the
//    phone's app mid-reply doesn't lose the reply, and the phone's own copy
//    merges with this one without a duplicate (same message id). Its steps
//    and questions go in too (an agent's tools, a request for permission), so
//    a question can be answered here, or on the phone once it is back, instead
//    of going unanswered (Hermes gives up after a few minutes) while the phone
//    is away.
//  * "watch": a phone that is open keeps one encrypted connection to this
//    computer and is told when this computer has pushed new data to the synced
//    copy, so it syncs at once instead of at its next poll.
//
// Phones that don't send what this needs (older versions: no chat id, device
// id or reply id) get what they always got: a reply, written nowhere else.

'use strict';

const Lease = require('./lease');
// Why a reply is stopped, as the abort signal's reason.
const { STOPPED } = require('./remote-server');

const MAX_WATCHERS = 16;
const INTERRUPTED = Lease.INTERRUPTED_ERROR;

function busyError(who, here) {
  const where = who && who.source !== 'local' && who.name ? who.name : here;
  const err = new Error(`A reply is already being written in this chat (on ${where}). Wait for it to finish, or stop it there first.`);
  err.code = 'busy';
  return err;
}

/**
 * @param storage       Storage (needs updateChat)
 * @param name          () => this computer's name
 * @param notify        (chatIds) => void, a chat was changed here (tell the window)
 * @param syncNow       () => void, sync now (pull a chat that isn't here yet, push a finished reply)
 * @param flushMs       how often a streaming reply is written into the chat
 * @param heartbeatMs   how often its lease is refreshed while it is quiet (a tool running, thinking)
 * @param orphanMs      how long a finished reply waits for its chat to arrive through sync
 * @param retryMs       how often it looks
 */
function createReplyHub({ storage, name = () => 'this computer', notify = () => {}, syncNow = () => {}, onAsk = () => {}, now = () => Date.now(), flushMs = 2000, heartbeatMs = Lease.HEARTBEAT_MS, orphanMs = 2 * 60 * 1000, retryMs = 3000 }) {
  const active = new Map();   // chat id -> who is writing its reply
  const watchers = new Set();
  const asking = new Map();   // an open question's run id -> the reply copy it is in

  function holder(chatId) {
    return (chatId && active.get(String(chatId))) || null;
  }

  // Claims the chat's reply. Returns release(); throws a `busy` error when
  // someone already writes one.
  function claim(chatId, who) {
    if (chatId == null || chatId === '') return () => {};
    const id = String(chatId);
    const current = active.get(id);
    if (current) throw busyError(current, name());
    const entry = { ...who };
    active.set(id, entry);
    return () => {
      if (active.get(id) === entry) active.delete(id);
    };
  }

  // ---- the phone's reply, kept in this computer's copy of the chat ----------

  // Which chat and message a phone's request is for, or null when it didn't say.
  function target(msg) {
    const chatId = typeof msg.chatId === 'string' ? msg.chatId : msg.req && typeof msg.req.chatId === 'string' ? msg.req.chatId : null;
    const r = msg.reply;
    if (!chatId || typeof msg.deviceId !== 'string' || !msg.deviceId || !r || typeof r.id !== 'string' || !r.id) return null;
    return {
      chatId,
      deviceId: msg.deviceId,
      deviceName: typeof msg.deviceName === 'string' && msg.deviceName ? msg.deviceName : 'your phone',
      replyId: r.id,
      at: Number.isFinite(r.at) ? r.at : now(),
      model: r.model && typeof r.model === 'object' ? r.model : null,
      // the model's provider on this computer (to answer its questions from here)
      provider: typeof msg.provider === 'string' ? msg.provider : null
    };
  }

  const askKey = (a) => `${a.runId}|${a.approvalId || ''}`;

  // Writes the reply as it comes: begin() -> delta(text)... -> finish(...).
  // onOver() is called once if the phone's copy turns out to have ended
  // already (the phone gave up on it, or it was stopped there).
  function mirror(t, { onOver = () => {} } = {}) {
    let text = '';
    const tools = [];       // the agent's steps
    const approvals = [];   // its questions, with the answer once there is one
    let status = null;
    let dirty = false;
    let timer = null;
    let chain = Promise.resolve();
    let over = false;      // the chat has this reply finished already (from the phone): leave it
    let lastSyncAsk = 0;
    const owner = () => Lease.newOwner(t.deviceId, t.deviceName, now());

    // One write; resolves to 'saved', 'missing' (the chat isn't here yet) or 'skipped'.
    const write = async (fin) => {
      let found = false;
      const saved = await storage.updateChat(t.chatId, (chat) => {
        found = true;
        let m = chat.messages.find((x) => x.id === t.replyId);
        if (!m) {
          m = { id: t.replyId, role: 'assistant', content: '', createdAt: t.at, model: t.model, pending: true };
          chat.messages.push(m);
        } else if (!m.pending && (m.interrupted || m.error === INTERRUPTED) && !m.mirrored) {
          // The phone's copy was cut off (it was closed, or its lease ran out
          // while this computer kept writing): this computer's reply is the
          // one that goes on.
          m.pending = true;
          delete m.interrupted;
          if (m.error === INTERRUPTED) delete m.error;
          if (m.notice === Lease.INTERRUPTED_NOTICE) delete m.notice;
        } else if (!m.pending) {
          // finished on the phone meanwhile
          if (!over) {
            over = true;
            onOver();
          }
          return false;
        } else if (m.owner && m.owner.deviceId !== t.deviceId) {
          return false; // someone else's reply under that id: never touch
        }
        if (text.length >= String(m.content || '').length) m.content = text;
        if (tools.length) m.tools = tools.map((x) => ({ ...x }));
        if (approvals.length) {
          // An answer given on any device (saved in the chat) is kept.
          const before = new Map((m.approvals || []).map((x) => [askKey(x), x]));
          for (const a of approvals) {
            const was = before.get(askKey(a));
            if (was && was.state !== 'pending' && was.state !== 'sending' && a.state === 'pending') a.state = was.state;
          }
          m.approvals = approvals.map((a) => ({ ...a }));
        }
        if (status && !fin) m.agentStatus = status;
        if (fin) {
          delete m.agentStatus;
          for (const a of m.approvals || []) if (a.state === 'pending' || a.state === 'sending') a.state = 'expired';
          for (const x of m.tools || []) if (x.status === 'running') x.status = fin.error || fin.interrupted ? 'stopped' : 'completed';
          m.pending = false;
          delete m.owner;
          delete m.runningOn;
          delete m.waiting;
          m.mirrored = true;
          if (fin.content != null && fin.content.length >= m.content.length) m.content = fin.content;
          if (fin.stats) m.stats = fin.stats;
          if (fin.error) m.error = fin.error;
          if (fin.notice) m.notice = fin.notice;
          if (fin.interrupted) m.interrupted = true;
        } else {
          m.owner = owner();
        }
        chat.updatedAt = now();
      });
      if (saved) {
        notify([t.chatId]);
        return 'saved';
      }
      return found ? 'skipped' : 'missing';
    };

    // A reply can go a long while without a word (a tool running, the model
    // thinking): refresh the lease anyway, or the other devices would see it
    // as cut off after a minute and a half.
    const beat = setInterval(() => {
      dirty = true;
      if (!timer) flush();
    }, heartbeatMs);
    if (beat.unref) beat.unref();

    const queue = (fin) => {
      const run = chain.then(() => (over ? 'skipped' : write(fin)));
      chain = run.catch(() => 'skipped');
      return run;
    };
    const flush = () => {
      timer = null;
      if (!dirty) return;
      dirty = false;
      queue(null).then((r) => {
        // The chat hasn't reached this computer yet: ask sync for it (not more
        // than every few seconds).
        if (r === 'missing' && now() - lastSyncAsk > 5000) {
          lastSyncAsk = now();
          syncNow();
        }
      }, () => {});
    };

    // The reply's message appears in the chat (marked as the phone's) before its first word.
    dirty = true;
    flush();

    const soon = () => {
      dirty = true;
      if (!timer) {
        timer = setTimeout(flush, flushMs);
        if (timer.unref) timer.unref();
      }
    };

    return {
      delta(piece) {
        if (over) return;
        text += piece;
        soon();
      },
      // What the agent does besides writing: { kind: 'tool' | 'approval' | 'status' | 'replace', ... }.
      info(evt) {
        if (over || !evt) return;
        if (evt.kind === 'tool') {
          const known = evt.id && tools.find((x) => x.id === evt.id);
          if (known) {
            known.status = evt.status || known.status;
            if (evt.relabel && evt.label) known.label = String(evt.label).slice(0, 200);
          } else if (evt.status !== 'completed') {
            tools.push({ id: evt.id || `${tools.length}`, emoji: evt.emoji || '', label: String(evt.label || evt.tool || 'tool').slice(0, 200), status: evt.status || 'running' });
          }
        } else if (evt.kind === 'approval' && evt.runId) {
          const a = {
            runId: String(evt.runId),
            approvalId: evt.approvalId || null,
            generation: Number.isInteger(evt.generation) ? evt.generation : null,
            provider: t.provider,
            origin: evt.origin && evt.origin.id ? evt.origin : null,
            connectorId: evt.connectorId || null,
            title: evt.title ? String(evt.title).slice(0, 200) : null,
            command: String(evt.command || '').slice(0, 2000),
            description: String(evt.description || '').slice(0, 500),
            choices: Array.isArray(evt.choices) && evt.choices.length ? evt.choices : ['once', 'deny'],
            state: 'pending'
          };
          approvals.push(a);
          asking.set(a.runId, this);
          onAsk(t.chatId, a);
        } else if (evt.kind === 'status') {
          status = evt.text ? String(evt.text).slice(0, 200) : null;
        } else if (evt.kind === 'replace' && typeof evt.text === 'string') {
          text = evt.text;
        } else {
          return;
        }
        soon();
      },
      // A question of this reply was answered (here or from the phone).
      answered(payload) {
        const a = approvals.find((x) => askKey(x) === askKey({ runId: payload.runId, approvalId: payload.approvalId || null }) && x.state === 'pending');
        if (!a) return false;
        a.state = payload.choice || 'once';
        soon();
        return true;
      },
      runIds: () => approvals.map((a) => a.runId),
      // The reply ended: `result` is what the model returned (or null), `error`
      // what went wrong. The reply is finished in the chat and synced.
      async finish({ result = null, error = null, aborted = false, interrupted = false } = {}) {
        clearTimeout(timer);
        clearInterval(beat);
        timer = null;
        // Like the phone's own copy: the full text when only the last bits are missing.
        const full = result && typeof result.text === 'string' && result.text.length > text.length && result.text.startsWith(text) ? result.text : null;
        if (full) text = full;
        const fin = {
          content: text,
          stats: result && result.stats ? { ...result.stats, engine: `${result.stats.engine || 'Model'} on ${name()}` } : null,
          error: error && !aborted ? `Error: ${error.message || error}` : null,
          notice: interrupted
            ? `This reply was cut off on ${name()} before it finished (the phone was away too long, or sharing was turned off). Tap Regenerate to ask again.`
            : result && result.stopReason === 'max_tokens'
              ? 'The reply was cut off at the length limit. Ask it to continue, or raise "Max tokens" in Settings.' : null,
          interrupted
        };
        const first = await queue(fin).catch(() => 'skipped');
        if (first === 'saved') {
          syncNow();
        } else if (first === 'missing') {
          // The chat is on the phone but hasn't been synced here yet: pull
          // until it arrives (the reply is kept meanwhile), then finish it.
          const until = now() + orphanMs;
          const retry = () => {
            if (over) return;
            syncNow();
            queue(fin).then((r) => {
              if (r === 'saved') syncNow();
              else if (r === 'missing' && now() < until) schedule();
            }, () => {});
          };
          const schedule = () => {
            const t2 = setTimeout(retry, retryMs);
            if (t2.unref) t2.unref();
          };
          schedule();
        }
        return first;
      }
    };
  }

  // Runs a chat request from the phone: claims the chat, mirrors the reply into
  // this computer's copy of the chat (when the phone says which), and releases.
  // run(onDelta, signal) does the work and returns what the model returned; it
  // is stopped (through that signal) when the phone's copy of the reply has
  // ended already, so the model doesn't write on, and hold the chat, for no one.
  async function remoteChat(msg, { emit, signal }, run) {
    const chatId = typeof msg.chatId === 'string' ? msg.chatId : msg.req && typeof msg.req.chatId === 'string' ? msg.req.chatId : null;
    const release = claim(chatId, { source: 'phone', deviceId: typeof msg.deviceId === 'string' ? msg.deviceId : null, name: typeof msg.deviceName === 'string' && msg.deviceName ? msg.deviceName : 'your phone' });
    const t = target(msg);
    const work = new AbortController();
    if (signal) {
      if (signal.aborted) work.abort(signal.reason);
      else signal.addEventListener('abort', () => work.abort(signal.reason), { once: true });
    }
    const copy = t ? mirror(t, { onOver: () => work.abort(STOPPED) }) : null;
    let result = null;
    let error = null;
    let aborted = false;
    try {
      result = await run((text) => {
        if (copy) copy.delta(text);
        emit({ t: 'delta', text });
      }, work.signal, (info) => {
        if (copy) copy.info(info);
        emit({ t: 'info', info });
      });
      return result;
    } catch (err) {
      error = err;
      aborted = !!(err && (err.name === 'AbortError' || /abort/i.test(String(err.message))));
      throw err;
    } finally {
      release();
      if (copy) for (const id of copy.runIds()) if (asking.get(id) === copy) asking.delete(id);
      const stopped = aborted || !!(result && result.aborted);
      // Stopped by the user: a normal ending. Stopped by anything else (no one
      // came back for it, sharing turned off): cut off, and says so.
      const cutOff = !!signal && signal.aborted && typeof signal.reason === 'string' && signal.reason !== STOPPED;
      if (copy) await copy.finish({ result, error, aborted: stopped, interrupted: cutOff });
    }
  }

  // ---- phones watching for changes ----------------------------------------

  // The "watch" request: stays open and passes on what announce() is given.
  function watch(_msg, { emit, signal }) {
    if (watchers.size >= MAX_WATCHERS) return Promise.reject(new Error('Too many phones are watching this computer.'));
    return new Promise((resolve) => {
      const send = (evt) => emit({ t: 'changed', ...evt });
      const done = () => {
        watchers.delete(send);
        resolve(null);
      };
      watchers.add(send);
      emit({ t: 'watching' });
      if (signal.aborted) done();
      else signal.addEventListener('abort', done, { once: true });
    });
  }

  // This computer pushed something to the synced copy: tell the watching phones.
  function announce({ chats = [], deleted = [], settings = false } = {}) {
    for (const send of [...watchers]) send({ chats, deleted, settings });
  }

  // A question was answered (on this computer, or from the phone): the copy
  // of the reply it is in says so too. False if it isn't one of ours.
  function answered(payload) {
    const copy = payload && asking.get(String(payload.runId));
    return copy ? copy.answered(payload) : false;
  }

  return { claim, holder, remoteChat, watch, announce, answered, watching: () => watchers.size };
}

module.exports = { createReplyHub };
