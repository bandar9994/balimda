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

  // The next piece of `text` to read, starting at `from`: up to the end of the
  // last finished sentence, or everything that's left when `final`. Returns
  // { chunk, next } (next = where the following piece starts), or null to
  // wait for more text. Pieces shorter than `min` letters wait for more.
  function nextChunk(text, from, final, min = 24) {
    const s = String(text || '');
    let end = s.length;
    if (!final) {
      // Don't read into a code block that's still being written.
      const fences = s.match(/```/g) || [];
      if (fences.length % 2) end = s.lastIndexOf('```');
      if (end <= from) return null;
      const rest = s.slice(from, end);
      const boundary = /[.!?؟…](?=\s)|\n/g;
      let last = -1;
      let m;
      while ((m = boundary.exec(rest))) {
        // "2." starting a numbered list item isn't the end of a sentence.
        if (m[0] === '.' && /(^|\n)\s*\d+$/.test(s.slice(0, from + m.index))) continue;
        last = m.index + m[0].length;
      }
      if (last < 0) return null;
      if (speakable(rest.slice(0, last)).replace(/[^\p{L}\p{N}]/gu, '').length < min) return null;
      end = from + last;
    }
    if (end <= from || !s.slice(from, end).trim()) return null;
    return { chunk: s.slice(from, end), next: end };
  }

  const api = { languageOf, speakable, nextChunk };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpeechText = api;
})(typeof window !== 'undefined' ? window : globalThis);
