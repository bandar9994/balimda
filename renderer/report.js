// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

// "Report" on a reply, the privacy policy link and the about note.
//
//  * buildMailto(): the pre-filled email a report opens in the user's own mail
//    app. Nothing is sent by the app: the user reads it and presses send. It
//    holds the reason, the note, the model name, the app version and platform
//    and the reported reply (cut to a safe length), and nothing else from the chat.
//  * isAllowedExternal(): which links the desktop app hands to the system
//    (main.js): web pages as before, and only this report email, no other mailto.
//  * The reported marks: kept only in this device's local state (state.json,
//    key "reported"), never in the chat or in sync.
//  * The strings, English and Arabic (shown in Arabic when the device is set to it).
//
// Loaded before app.js (window.Report), by main.js and by the tests (require).

(function (root) {
  'use strict';

  const SUPPORT_EMAIL = 'bandar.altariqi@gmail.com';
  const SUBJECT = 'Najwa AI: reported reply';
  const PRIVACY_URL = 'https://bandar9994.github.io/privacy.html';

  // What is kept of the reply in the email, and the longest the whole link may get
  // (some mail apps refuse longer ones; Arabic takes 6 characters of link per letter).
  const MAX_REPLY_CHARS = 1500;
  const MAX_URL_CHARS = 4000;
  const MAX_NOTE_CHARS = 500;
  // How many reported marks are kept on a device.
  const MAX_REPORTED = 500;

  const REASONS = ['Offensive', 'Sexual', 'Violent', 'Hateful', 'Dangerous', 'Other'];

  const STRINGS = {
    en: {
      report: () => 'Report',
      reported: () => 'Reported',
      reportTitle: () => 'Report this reply',
      reportIntro: () => 'Tell us what is wrong with this reply. Your mail app opens with a message ready to send: nothing is sent until you press send.',
      reason: () => 'Reason',
      reasonName: (r) => ({ Offensive: 'Offensive', Sexual: 'Sexual', Violent: 'Violent', Hateful: 'Hateful', Dangerous: 'Dangerous', Other: 'Other' })[r] || r,
      note: () => 'Note (optional)',
      notePlaceholder: () => 'What went wrong?',
      pickReason: () => 'Choose a reason.',
      cancel: () => 'Cancel',
      send: () => 'Report',
      close: () => 'Close',
      opened: () => `Your mail app should open with the report. Press send to report it. If it doesn't open, write to ${SUPPORT_EMAIL}.`,
      privacy: () => 'Privacy policy',
      privacyOpen: () => 'Read the privacy policy',
      useTitle: () => 'Responsible use',
      useNote: () => 'Don\'t use Najwa AI to create illegal or harmful content. Models you download from third parties aren\'t made or controlled by Najwa AI.'
    },
    ar: {
      report: () => 'إبلاغ',
      reported: () => 'تم الإبلاغ',
      reportTitle: () => 'الإبلاغ عن هذا الرد',
      reportIntro: () => 'أخبرنا ما المشكلة في هذا الرد. سيفتح تطبيق البريد برسالة جاهزة، ولن يُرسل شيء حتى تضغط إرسال.',
      reason: () => 'السبب',
      reasonName: (r) => ({ Offensive: 'مسيء', Sexual: 'جنسي', Violent: 'عنيف', Hateful: 'يحرّض على الكراهية', Dangerous: 'خطير', Other: 'أخرى' })[r] || r,
      note: () => 'ملاحظة (اختياري)',
      notePlaceholder: () => 'ما المشكلة؟',
      pickReason: () => 'اختر سببًا.',
      cancel: () => 'إلغاء',
      send: () => 'إبلاغ',
      close: () => 'إغلاق',
      opened: () => `سيفتح تطبيق البريد برسالة الإبلاغ. اضغط إرسال لإتمام الإبلاغ. إذا لم يفتح، راسل ${SUPPORT_EMAIL}.`,
      privacy: () => 'سياسة الخصوصية',
      privacyOpen: () => 'قراءة سياسة الخصوصية',
      useTitle: () => 'الاستخدام المسؤول',
      useNote: () => 'لا تستخدم نجوى AI لإنشاء محتوى غير قانوني أو ضار. النماذج التي تنزّلها من أطراف أخرى لا تصنعها نجوى AI ولا تتحكم بها.'
    }
  };
  // The app's language (Settings → General), else the device's.
  const language = () => (root.I18n ? root.I18n.lang() : typeof navigator !== 'undefined' && /^ar/i.test(navigator.language || '') ? 'ar' : 'en');
  const text = (key, arg, lang = language()) => (STRINGS[lang] || STRINGS.en)[key](arg);

  // ---- the email ----------------------------------------------------------------

  const clean = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n');

  // Cuts at `max` characters without splitting a surrogate pair.
  function cut(s, max) {
    if (s.length <= max) return s;
    let end = max;
    const c = s.charCodeAt(end - 1);
    if (c >= 0xD800 && c <= 0xDBFF) end -= 1;
    return s.slice(0, end);
  }

  const link = (body) => `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(SUBJECT)}&body=${encodeURIComponent(body).replace(/%0A/g, '%0D%0A')}`;

  /**
   * @param reason    one of REASONS
   * @param note      what the user wrote (optional)
   * @param model     the model or provider name
   * @param version   the app version
   * @param platform  what the app runs on
   * @param reply     the reported reply's text
   * @returns { url, truncated, replyChars }
   */
  function buildMailto({ reason, note = '', model = '', version = '', platform = '', reply = '' } = {}) {
    const why = REASONS.includes(reason) ? reason : 'Other';
    const noteText = cut(clean(note).trim(), MAX_NOTE_CHARS);
    const full = clean(reply).trim();
    const header = [
      `Reason: ${why}`,
      `Note: ${noteText || '(none)'}`,
      `Model: ${clean(model).replace(/\n/g, ' ') || '(unknown)'}`,
      `App: Najwa AI ${clean(version).replace(/\n/g, ' ') || '(unknown)'} on ${clean(platform).replace(/\n/g, ' ') || '(unknown)'}`
    ].join('\n');
    const make = (keep) => {
      const shown = cut(full, keep);
      const truncated = shown.length < full.length;
      const body = `${header}\n\nReply${truncated ? ` (cut to the first ${shown.length} of ${full.length} characters)` : ''}:\n${shown}\n`;
      return { url: link(body), truncated, replyChars: shown.length };
    };
    let keep = Math.min(MAX_REPLY_CHARS, full.length);
    let out = make(keep);
    // Long Arabic (or many accents) makes a long link: keep less until it fits.
    while (out.url.length > MAX_URL_CHARS && keep > 0) {
      keep = Math.floor(keep * 0.85);
      out = make(keep);
    }
    return out;
  }

  // ---- which links the app opens outside itself ----------------------------------

  // Web pages (as before) and the report email: mailto to the support address
  // only, with only a subject and a body. Nothing else (no other recipient, no
  // cc/bcc, no other scheme).
  function isAllowedExternal(url) {
    const s = String(url || '').trim();
    if (/^https?:\/\//.test(s)) return true;
    if (!/^mailto:/i.test(s)) return false;
    const rest = s.slice(7);
    const q = rest.indexOf('?');
    const to = q < 0 ? rest : rest.slice(0, q);
    let who;
    try { who = decodeURIComponent(to); } catch { return false; }
    if (who.toLowerCase() !== SUPPORT_EMAIL) return false;
    if (q < 0) return true;
    for (const part of rest.slice(q + 1).split('&')) {
      if (!part) continue;
      const key = part.split('=')[0].toLowerCase();
      if (key !== 'subject' && key !== 'body') return false;
    }
    return true;
  }

  // ---- reported marks (this device only) -----------------------------------------

  const markKey = (chatId, msgId) => `${chatId}:${msgId}`;
  const isReported = (reported, chatId, msgId) => !!reported && typeof reported === 'object' && Object.prototype.hasOwnProperty.call(reported, markKey(chatId, msgId));

  // Returns the new marks (a copy), oldest dropped when there are too many.
  function addReported(reported, chatId, msgId, reason, now = Date.now()) {
    const next = { ...(reported && typeof reported === 'object' && !Array.isArray(reported) ? reported : {}) };
    next[markKey(chatId, msgId)] = { reason: REASONS.includes(reason) ? reason : 'Other', at: now };
    const keys = Object.keys(next);
    if (keys.length > MAX_REPORTED) {
      keys.sort((a, b) => ((next[a] && next[a].at) || 0) - ((next[b] && next[b].at) || 0));
      for (const k of keys.slice(0, keys.length - MAX_REPORTED)) delete next[k];
    }
    return next;
  }

  // Marks of a chat that no longer exists go too.
  function dropReported(reported, chatId) {
    const next = {};
    for (const [k, v] of Object.entries(reported && typeof reported === 'object' ? reported : {})) {
      if (!k.startsWith(`${chatId}:`)) next[k] = v;
    }
    return next;
  }

  // What was read from the local state: only well-formed marks survive.
  function readReported(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [k, v] of Object.entries(raw)) {
      if (k.includes(':') && v && typeof v === 'object' && Number.isFinite(v.at)) out[k] = { reason: REASONS.includes(v.reason) ? v.reason : 'Other', at: v.at };
    }
    return out;
  }

  const api = { SUPPORT_EMAIL, SUBJECT, PRIVACY_URL, REASONS, STRINGS, MAX_REPLY_CHARS, MAX_URL_CHARS, MAX_REPORTED, text, language, buildMailto, isAllowedExternal, isReported, addReported, dropReported, readReported };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Report = api;
})(typeof window !== 'undefined' ? window : globalThis);
