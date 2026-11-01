// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const I18n = require('../renderer/i18n.js');
const AR = require('../renderer/i18n-ar.js');

test('the language: a setting, else the device\'s', () => {
  assert.strictEqual(I18n.resolve('ar', 'en-US'), 'ar');
  assert.strictEqual(I18n.resolve('en', 'ar-SA'), 'en');
  assert.strictEqual(I18n.resolve('', 'ar-SA'), 'ar');
  assert.strictEqual(I18n.resolve('', 'ar'), 'ar');
  assert.strictEqual(I18n.resolve('', 'en-GB'), 'en');
  assert.strictEqual(I18n.resolve('system', 'fr'), 'en');
});

test('English stays English; Arabic swaps the app\'s text, keeping what changes', () => {
  I18n.setLanguage('en', { doc: null, store: false });
  assert.strictEqual(I18n.t('Settings'), 'Settings');
  I18n.setLanguage('ar', { doc: null, store: false });
  try {
    assert.strictEqual(I18n.lang(), 'ar');
    assert.strictEqual(I18n.t('Settings'), 'الإعدادات');
    // Spaces around it stay.
    assert.strictEqual(I18n.t('  Settings '), '  الإعدادات ');
    // A part that changes is kept as it is.
    assert.strictEqual(I18n.t('Connected · 12 models'), 'متصل · النماذج: 12');
    assert.strictEqual(I18n.t('Remove notes.md'), 'إزالة notes.md');
    // A plural "s" isn't carried over.
    assert.strictEqual(I18n.t('Used 3 tools'), 'الأدوات المستخدمة: 3');
    // The changing part can be the app's text too.
    assert.strictEqual(I18n.t('Error: Hermes didn\'t start the run.'), 'خطأ: لم يبدأ Hermes التشغيل.');
    assert.strictEqual(I18n.t('Thinking… (40 words)'), 'جارٍ التفكير… (40 كلمة)');
    // What isn't the app's text is left alone.
    assert.strictEqual(I18n.t('How do I bake bread?'), 'How do I bake bread?');
    assert.strictEqual(I18n.t('مرحبا'), 'مرحبا');
    assert.strictEqual(I18n.t(''), '');
  } finally {
    I18n.setLanguage('en', { doc: null, store: false });
  }
});

test('every Arabic entry is still the English the app shows', () => {
  // A key the app no longer shows would be dead weight; one with a typo would
  // never match. Each of its fixed parts must be in the app's code (a key
  // drawn from several, like "✓ Allowed once" or "🤖 Assistant", is checked piece by piece).
  const root = path.join(__dirname, '..');
  const files = ['renderer/app.js', 'renderer/index.html', 'renderer/attach-files.js', 'mobile/src/bridge.js', 'mobile/src/on-device.js',
    'mobile/src/native-engine.js', 'src/providers.js', 'src/remote.js', 'src/reply-hub.js', 'src/remote-server.js', 'src/storage.js', 'main.js'];
  const src = files.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n').replace(/\\'/g, '\'').replace(/\\"/g, '"').replace(/\\n/g, '\n');
  const missing = [];
  for (const key of Object.keys(AR)) {
    const pieces = key.split(/\{\}|[✓✗·():]|\p{Extended_Pictographic}\uFE0F?/u).map((p) => p.trim()).filter((p) => p.length >= 3);
    if (pieces.some((p) => !src.includes(p))) missing.push(key);
  }
  assert.deepStrictEqual(missing, []);
});

test('the Arabic keeps every part that changes', () => {
  for (const [en, ar] of Object.entries(AR)) {
    const holes = en.split('{}').length - 1;
    const used = (ar.match(/\{\d*\}/g) || []).length;
    // A numbered entry may leave a part out (a plural "s"); an unnumbered one has them all.
    if (!/\{\d+\}/.test(ar)) assert.strictEqual(used, holes, `${en} → ${ar}`);
    assert.ok(/[؀-ۿ]/.test(ar) || /^[A-Za-z ]+$/.test(ar), `no Arabic in: ${ar}`);
  }
});
