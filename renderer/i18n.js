// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

// The app's language: English or Arabic (Settings → General → Language).
//
// The app is written in English. In Arabic, every piece of the app's own text
// that appears on screen (labels, buttons, menus, notes, tips, placeholders) is
// swapped for its Arabic as it appears, and the layout reads right to left.
// The Arabic is in i18n-ar.js, keyed by the English text; "{}" in a key stands
// for a part that changes (a name, a number), kept as is in the Arabic.
//
// Chats themselves (what you and the models write, chat titles you gave, file
// names, code) are never changed: anything inside an element marked
// translate="no" (app.js marks them), code and text boxes is left alone.
//
// Loaded before app.js (window.I18n) and by the tests (require).

(function (root) {
  'use strict';

  const DICT = (typeof module !== 'undefined' && module.exports ? require('./i18n-ar.js') : root.I18nArabic) || {};
  const LANGUAGES = ['en', 'ar'];
  const STORE_KEY = 'najwa.language';

  let lang = 'en';
  const exact = new Map();
  const patterns = [];
  for (const [key, value] of Object.entries(DICT)) {
    // Spaces around a piece of text are the screen's, not the words'.
    const en = key.trim();
    const ar = value.trim();
    if (en.includes('{}')) {
      const parts = en.split('{}').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      patterns.push({ re: new RegExp(`^${parts.join('([\\s\\S]*?)')}$`), ar, holes: parts.length - 1, fixed: en.replace(/\{\}/g, '').length });
    } else {
      exact.set(en, ar);
    }
  }
  // The most specific pattern first ("Connected · {} models" before "{} models").
  patterns.sort((a, b) => b.fixed - a.fixed);

  const cache = new Map();

  // Fills the Arabic's "{}" (in order) or "{1}", "{2}"… (by number) with the parts.
  function fill(ar, parts) {
    let next = 0;
    return ar.replace(/\{(\d*)\}/g, (_, n) => {
      const v = n ? parts[Number(n) - 1] : parts[next++];
      return v == null ? '' : v;
    });
  }

  // The Arabic for one piece of the app's text, or null when there is none.
  function lookup(text, depth = 0, split = true) {
    if (exact.has(text)) return exact.get(text);
    if (depth > 2 || text.length > 4000) return null;
    const multi = text.includes(' · ');
    // A pattern for the whole line, unless it would swallow several pieces
    // of a line made of pieces into one part ("{} MB" for "Fastest · … · 490 MB").
    const whole = matchPattern(text, depth, multi);
    if (whole != null) return whole;
    if (multi && split) {
      // Each piece on its own, the longest that has an Arabic first.
      const joined = pieces(text.split(' · '), depth);
      if (joined != null) return joined;
    }
    return multi && split ? matchPattern(text, depth, false) : null;
  }

  function matchPattern(text, depth, singlePieces) {
    for (const p of patterns) {
      const m = p.re.exec(text);
      if (!m) continue;
      if (singlePieces && m.slice(1).some((v) => v && v.includes(' · '))) continue;
      // The changing parts can be the app's text too ("Error: Couldn't reach…").
      const parts = m.slice(1).map((v) => (v && /[A-Za-z]/.test(v) ? spaced(v, depth + 1) ?? v : v));
      return fill(p.ar, parts);
    }
    return null;
  }

  function pieces(segs, depth) {
    const out = [];
    let found = false;
    for (let i = 0; i < segs.length;) {
      let j = segs.length;
      let ar = null;
      // (The whole line was already tried by the caller.)
      for (; j > i; j--) {
        if (i === 0 && j === segs.length) continue;
        // (Several pieces together only as one known text, not split again.)
        ar = lookup(segs.slice(i, j).join(' · '), depth + 1, j - i === 1);
        if (ar != null) break;
      }
      if (ar != null) { out.push(ar); found = true; i = j; } else { out.push(segs[i]); i += 1; }
    }
    return found ? out.join(' · ') : null;
  }

  // lookup() for text with spaces around it, which stay.
  function spaced(text, depth = 0) {
    const trimmed = text.trim();
    const found = lookup(trimmed, depth);
    if (found == null) return null;
    const at = text.indexOf(trimmed);
    return text.slice(0, at) + found + text.slice(at + trimmed.length);
  }

  /** The text in the app's language (unchanged in English, or when there's no Arabic for it). */
  function t(text) {
    if (lang !== 'ar' || typeof text !== 'string' || !/[A-Za-z]/.test(text)) return text;
    if (cache.has(text)) return cache.get(text) ?? text;
    const out = spaced(text);
    if (cache.size > 5000) cache.clear();
    cache.set(text, out);
    return out ?? text;
  }

  /** 'en' or 'ar' for a setting ('' or 'system' = the device's language). */
  function resolve(pref, deviceLang) {
    if (LANGUAGES.includes(pref)) return pref;
    const device = deviceLang != null ? deviceLang : (typeof navigator !== 'undefined' ? navigator.language || '' : '');
    return /^ar\b/i.test(device) ? 'ar' : 'en';
  }

  // Dates and times in the app's language (Western digits, the usual calendar).
  function locale() {
    return lang === 'ar' ? 'ar-u-ca-gregory-nu-latn' : undefined;
  }

  // ---- the screen -----------------------------------------------------------

  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  // What each text node and attribute said in English, and what it says now:
  // so a switch back to English restores it, and the app's own changes are told
  // apart from ours.
  const textWas = new WeakMap();
  const attrWas = new WeakMap();
  let observer = null;

  // Text that isn't the app's: what people and models wrote, code, text boxes.
  function skipped(el) {
    return !el || !!el.closest('[translate="no"], pre, code, textarea, script, style, [contenteditable="true"]');
  }
  // A text box's placeholder and tip are the app's, though.
  function attrsSkipped(el) {
    return !el || !!el.closest('[translate="no"]');
  }

  // Shows a text node in the app's language. Writes only when it changes it
  // (each write comes back as a change), so the screen settles at once.
  function doText(node) {
    const rec = textWas.get(node);
    const now = node.nodeValue;
    // Still what we wrote: its English is the one we kept. Otherwise the app
    // wrote it, in English.
    const en = rec && now === rec.out ? rec.en : now;
    if (!/[A-Za-z]/.test(en)) { textWas.delete(node); return; }
    const out = t(en);
    if (out !== now) node.nodeValue = out;
    textWas.set(node, { en, out });
  }

  function doAttrs(el) {
    let recs = attrWas.get(el);
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const now = el.getAttribute(a);
      const rec = recs && recs[a];
      const en = rec && now === rec.out ? rec.en : now;
      if (!/[A-Za-z]/.test(en)) continue;
      const out = t(en);
      if (out !== now) el.setAttribute(a, out);
      if (!recs) attrWas.set(el, (recs = {}));
      recs[a] = { en, out };
    }
  }

  function walk(node) {
    if (node.nodeType === 3) {
      if (!skipped(node.parentElement)) doText(node);
      return;
    }
    if (node.nodeType !== 1) return;
    if (!attrsSkipped(node)) doAttrs(node);
    if (skipped(node)) return;
    const doc = node.ownerDocument;
    const it = doc.createTreeWalker(node, 5 /* elements and text */, {
      acceptNode: (n) => {
        if (n.nodeType !== 1 || !skipped(n)) return 1;
        if (!attrsSkipped(n)) doAttrs(n);
        return 2; // reject, with its children
      }
    });
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      if (n.nodeType === 3) doText(n);
      else doAttrs(n);
    }
  }

  function onMutations(list) {
    for (const m of list) {
      if (m.type === 'childList') for (const n of m.addedNodes) walk(n);
      else if (m.type === 'characterData') { if (!skipped(m.target.parentElement)) doText(m.target); }
      else if (m.type === 'attributes' && !attrsSkipped(m.target)) doAttrs(m.target);
    }
  }

  /** Keeps everything under `el` (the whole page) in the app's language. */
  function watch(el) {
    if (observer || typeof MutationObserver === 'undefined') return;
    walk(el);
    observer = new MutationObserver(onMutations);
    observer.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  /** Switches the app's language now (and for the next start, before settings load). */
  function setLanguage(next, { doc = typeof document !== 'undefined' ? document : null, store = true } = {}) {
    next = LANGUAGES.includes(next) ? next : 'en';
    const changed = next !== lang;
    lang = next;
    cache.clear();
    if (store) {
      try { root.localStorage.setItem(STORE_KEY, lang); } catch { /* not kept: fine */ }
    }
    if (doc && doc.documentElement) {
      doc.documentElement.lang = lang;
      doc.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
      if (changed && doc.body) walk(doc.body);
    }
    return changed;
  }

  // The language last used, until the settings are read.
  function remembered() {
    try { return root.localStorage.getItem(STORE_KEY) || ''; } catch { return ''; }
  }

  const api = { t, resolve, locale, setLanguage, watch, remembered, lang: () => lang, LANGUAGES, size: () => exact.size + patterns.length };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.I18n = api;
})(typeof window !== 'undefined' ? window : globalThis);
