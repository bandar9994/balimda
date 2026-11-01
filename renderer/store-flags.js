// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

// What this build may show, depending on where it was published. The Google
// Play build (built with NAJWA_STORE=play, see android/app/build.gradle) has no
// donation link; every other build (desktop, GitHub/sideloaded Android, iPhone)
// does. info.store comes from app.info(): the Android app reports the value it
// was built with ("play" or ""), and "unknown" if it can't tell, which is
// treated like Play. The desktop app reports nothing.
// This is the only place in the app that holds the donation URL and its name.
// Loaded before app.js (window.StoreFlags) and by the tests (require).

(function (root) {
  'use strict';

  const DONATION = { url: 'https://ko-fi.com/bandaraltariqi', label: '☕ Support on Ko-fi' };
  // Its name in Arabic (kept here with it, not in i18n-ar.js).
  const LABEL_AR = '☕ الدعم عبر Ko-fi';

  // Stores that must not link to outside donation pages.
  const NO_DONATIONS = new Set(['play', 'unknown']);

  // The donation link ({ url, label }), or null when this build must not show it.
  function support(info) {
    const store = String((info && info.store) || '').trim().toLowerCase();
    if (NO_DONATIONS.has(store)) return null;
    const ar = root.I18n && root.I18n.lang() === 'ar';
    return { ...DONATION, ...(ar ? { label: LABEL_AR } : {}) };
  }

  const api = { support };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StoreFlags = api;
})(typeof window !== 'undefined' ? window : globalThis);
