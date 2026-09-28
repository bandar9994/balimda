// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Turning replies into speech: plain text a voice can read (no Markdown,
// links or code), the language to read it in, and sentence-sized pieces so a
// reply can be read aloud while it's still being written.
// Loaded before app.js (window.SpeechText) and by the tests (require).

(function (root) {
  'use strict';

  const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
  const LATIN = /[A-Za-z]/g;

  // "ar" or "en": the script most of the letters are in (`fallback` if none).
  function languageOf(text, fallback = 'en') {
    const ar = (String(text).match(ARABIC) || []).length;
    const en = (String(text).match(LATIN) || []).length;
    if (!ar && !en) return fallback;
    return ar >= en ? 'ar' : 'en';
  }

  // Markdown -> text to read aloud.
  function speakable(md) {
    let t = String(md || '');
    t = t.replace(/```[\s\S]*?(```|$)/g, '\n');                 // code blocks aren't read
    t = t.replace(/<[^>\n]+>/g, ' ');                            // HTML tags
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');                 // pictures
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');               // [text](link) -> text
    t = t.replace(/\bhttps?:\/\/\S+/g, ' ');                     // bare links
    t = t.replace(/`([^`]*)`/g, '$1');                           // `code` -> code
    t = t.replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, ' '); // table rules
    t = t.replace(/[ \t]*\|[ \t]*/g, ', ');                         // table cells
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');                    // headings
    t = t.replace(/^\s*>\s?/gm, '');                             // quotes
    t = t.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '');            // list markers
    t = t.replace(/(\*\*|__|~~)(.+?)\1/g, '$2');                 // bold, strikethrough
    t = t.replace(/(^|[\s(])[*_](?!\s)([^*_\n]*?[^\s*_])[*_](?=[\s).,!?؟:;،]|$)/gm, '$1$2'); // italics
    t = t.replace(/^\s*[-*_]{3,}\s*$/gm, ' ');                   // horizontal rules
    t = t.replace(/\p{Extended_Pictographic}\uFE0F?/gu, ' ');  // emoji
    // Each line ends with a pause, so lists and headings don't run together.
    return t.split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, ''))
      .filter((line) => /[\p{L}\p{N}]/u.test(line))
      .map((line) => (/[.!?؟:;،…]$/.test(line) ? line : `${line}.`))
      .join(' ');
  }

  // Pieces are at most about this long: a voice can't take a whole long reply
  // at once (Android refuses over 4000 characters), a piece is read in one
  // voice, and a stopped reading stops sooner.
  const MAX = 400;

  // The next piece of `text` to read, starting at `from`: whole sentences, up
  // to about MAX characters, or what's left when `final` (the reply is
  // finished). Returns { chunk, next } (next = where the following piece
  // starts), or null to wait for more text. While the reply is still being
  // written, pieces shorter than `min` letters wait for more.
  function nextChunk(text, from, final, min = 24) {
    const s = String(text || '');
    let end = s.length;
    // Don't read into a code block that's still being written.
    if (!final && (s.match(/```/g) || []).length % 2) end = s.lastIndexOf('```');
    if (end <= from) return null;
    const rest = s.slice(from, end);
    if (!rest.trim()) return null;
    // The last sentence end within MAX (or the first one after it, for a long sentence).
    const boundary = /[.!?؟…](?=\s)|\n/g;
    let cut = -1;
    let m;
    while ((m = boundary.exec(rest))) {
      // "2." starting a numbered list item isn't the end of a sentence.
      if (m[0] === '.' && /(^|\n)\s*\d+$/.test(s.slice(0, from + m.index))) continue;
      const at = m.index + m[0].length;
      if (at > MAX && cut > 0) break;
      cut = at;
      if (at > MAX) break;
    }
    if (final && (cut < 0 || rest.length <= MAX)) cut = rest.length;
    if (cut < 0) return null; // no finished sentence yet
    if (cut > MAX * 2) {
      // One very long sentence: break it at a space.
      const space = rest.lastIndexOf(' ', MAX);
      if (space > 0) cut = space + 1;
    }
    const chunk = rest.slice(0, cut);
    if (!final && speakable(chunk).replace(/[^\p{L}\p{N}]/gu, '').length < min) return null;
    if (!chunk.trim()) return { chunk: '', next: from + cut };
    return { chunk, next: from + cut };
  }

  const api = { languageOf, speakable, nextChunk };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpeechText = api;
})(typeof window !== 'undefined' ? window : globalThis);
