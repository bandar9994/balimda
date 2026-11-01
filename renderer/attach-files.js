// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

// Text and code files attached to a message (.md, .txt, .js, .py, .json…).
// They're read on the device and kept with the message as text, so every
// model can read them, and later turns still can. Anything that isn't text (a
// PDF, a zip, an app) is turned down with a clear reason.
// Loaded before app.js (window.AttachFiles) and by the tests (require).

(function (root) {
  'use strict';

  const MAX_FILES = 5;               // per message
  const MAX_BYTES = 2 * 1024 * 1024; // a bigger file isn't read at all
  const MAX_CHARS = 150000;          // kept per file (about 40,000 words)
  const ON_DEVICE_CHARS = 6000;      // what the phone's own small models read per file

  // A file's bytes as text, or null when they aren't text.
  function decodeText(bytes) {
    const head = bytes.subarray(0, 8192);
    // Text has no zero bytes (UTF-16 files do, and are rare for code: not read).
    if (head.includes(0)) return null;
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // Not UTF-8: an older single-byte encoding is still readable text, as
      // long as it isn't mostly control characters (binary data).
      text = new TextDecoder('windows-1252').decode(bytes);
    }
    const sample = text.slice(0, 8192);
    let odd = 0;
    for (let i = 0; i < sample.length; i++) {
      const c = sample.charCodeAt(i);
      if ((c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) || c === 0xfffd) odd++;
    }
    if (sample.length && odd / sample.length > 0.02) return null;
    return text.replace(/^﻿/, '');
  }

  /**
   * Reads one picked file. Resolves with { file: { name, size, text, cut } }
   * or { error } in words the person can act on.
   */
  async function readTextFile(file) {
    const name = String(file.name || 'file').slice(0, 200);
    if (file.size > MAX_BYTES) return { error: `${name} is too big to attach (the limit is ${formatSize(MAX_BYTES)}).` };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = decodeText(bytes);
    if (text == null) return { error: `${name} isn't a text file. Najwa AI can attach pictures and text or code files (.txt, .md, .js, .py, .json, .csv…).` };
    const cut = text.length > MAX_CHARS;
    return { file: { name, size: bytes.length, text: cut ? text.slice(0, MAX_CHARS) : text, ...(cut ? { cut: true } : {}) } };
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  // What the model reads for one file. `cap` shortens it further (a small
  // model on the phone has little room).
  function fileBlock(f, cap = MAX_CHARS) {
    let text = String(f.text || '');
    const shortened = text.length > cap;
    if (shortened) text = text.slice(0, cap);
    const note = shortened || f.cut ? '\n[… the rest of the file was left out: it is too long]' : '';
    const name = String(f.name || 'file').replace(/"/g, "'");
    return `<file name="${name}">\n${text}${note}\n</file>`;
  }

  // How much of each file a model reads.
  function capFor(model) {
    return model && model.provider === 'onDevice' ? ON_DEVICE_CHARS : MAX_CHARS;
  }

  // A note for the reply when the model read only part of a file, or '' when
  // it read them all.
  function shortenedNotice(files, cap = MAX_CHARS) {
    const n = (x) => Number(x).toLocaleString('en-US');
    const parts = files.filter((f) => String(f.text || '').length > cap).map((f) => `${n(cap)} of ${n(String(f.text).length)} characters of ${f.name}`);
    if (parts.length) {
      return `This model could read only the first ${parts.join(', and the first ')}, so its answer is based on part of the file. For the whole file, use a bigger model: your computer's, or one with an API key (such as Claude or DeepSeek).`;
    }
    const cut = files.filter((f) => f.cut).map((f) => f.name);
    if (cut.length) return `Only the first ${n(MAX_CHARS)} characters of ${cut.join(' and ')} were attached: the file is too long to attach whole.`;
    return '';
  }

  // The files a message holds (whatever a synced chat contains, only well-formed ones).
  function filesOf(msg) {
    return (msg && Array.isArray(msg.files) ? msg.files : []).filter((f) => f && typeof f.name === 'string' && typeof f.text === 'string');
  }

  const api = { MAX_FILES, MAX_BYTES, MAX_CHARS, ON_DEVICE_CHARS, decodeText, readTextFile, formatSize, fileBlock, capFor, shortenedNotice, filesOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AttachFiles = api;
})(typeof window !== 'undefined' ? window : globalThis);
