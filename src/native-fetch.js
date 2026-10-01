// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// fetch() through the phone's own network code (the "Net" plugin:
// NetPlugin.java on Android, NetPlugin.swift on iOS) instead of the app's web
// view. A web view says which page every request comes from (its Origin), and
// servers like Hermes Agent refuse origins they don't list. The phone's own
// requests carry none, like the desktop app's, so they just work.
//
// The plugin:
//   request({ id, url, method, headers, body }) resolves with
//     { status, headers } once the answer starts,
//   then "net" events bring { id, data } (base64 bytes), and finally
//     { id, done: true } or { id, error }.
//   cancel({ id }) stops a request.

'use strict';

const NULL_BODY = new Set([101, 204, 205, 304]);

const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

// Like fetch, a failed connection is a TypeError; this one already says in
// words what went wrong (the app shows it as it is).
function networkError(message) {
  const err = new TypeError(message || 'Network request failed');
  err.explained = true;
  return err;
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function plainHeaders(headers) {
  const out = {};
  if (headers) new Headers(headers).forEach((value, name) => { out[name] = value; });
  return out;
}

/** @param Net  the registered "Net" Capacitor plugin */
function makeNativeFetch(Net) {
  const open = new Map();  // id -> { controller, done() }
  let nextId = 0;
  let listening = null;

  const listen = () => {
    if (!listening) {
      listening = Promise.resolve(Net.addListener('net', (evt) => {
        const req = open.get(evt.id);
        if (!req) return;
        try {
          if (evt.data) {
            req.controller.enqueue(fromBase64(evt.data));
          } else if (evt.error) {
            req.done();
            req.controller.error(networkError(evt.error));
          } else if (evt.done) {
            req.done();
            req.controller.close();
          }
        } catch {
          // the reader already went away
        }
      }));
    }
    return listening;
  };

  return async function nativeFetch(url, init = {}) {
    const signal = init.signal;
    if (signal && signal.aborted) throw abortError();
    await listen();
    const id = `net${++nextId}`;
    const cancel = () => Net.cancel({ id }).catch(() => {});

    // The body is set up first: its pieces may come in before request() returns.
    let controller;
    const body = new ReadableStream({
      start(c) {
        controller = c;
      },
      cancel() {
        if (open.has(id)) {
          req.done();
          cancel();
        }
      }
    });
    const onAbort = () => {
      if (!open.has(id)) return;
      req.done();
      cancel();
      try {
        controller.error(abortError());
      } catch {
        // already closed
      }
    };
    const req = {
      controller,
      done: () => {
        open.delete(id);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    };
    open.set(id, req);
    if (signal) signal.addEventListener('abort', onAbort);

    let head;
    try {
      head = await Net.request({
        id,
        url: String(url),
        method: (init.method || 'GET').toUpperCase(),
        headers: plainHeaders(init.headers),
        body: init.body == null ? null : String(init.body)
      });
    } catch (err) {
      req.done();
      if (signal && signal.aborted) throw abortError();
      throw networkError(err && err.message);
    }
    if (signal && signal.aborted) throw abortError();
    const status = Number(head.status);
    if (!(status >= 200 && status <= 599)) {
      req.done();
      cancel();
      throw networkError(`The server sent an invalid answer (status ${head.status}).`);
    }
    const headers = head.headers || {};
    if (NULL_BODY.has(status)) {
      req.done();
      return new Response(null, { status, headers });
    }
    return new Response(body, { status, headers });
  };
}

module.exports = { makeNativeFetch };
