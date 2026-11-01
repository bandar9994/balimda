// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

// The bundled Readex Pro font: the files exist, the CSS loads them from the
// app itself (no network), for Arabic and Latin, and the licence is shipped.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const css = read('renderer', 'styles.css');
const FILES = ['ReadexPro-Arabic.woff2', 'ReadexPro-Latin.woff2', 'ReadexPro-LatinExt.woff2'];

test('the Readex Pro files are real WOFF2 fonts', () => {
  for (const name of FILES) {
    const buf = fs.readFileSync(path.join(root, 'renderer', 'fonts', name));
    assert.strictEqual(buf.subarray(0, 4).toString('latin1'), 'wOF2', name);
    assert.ok(buf.length > 10000 && buf.length < 200000, `${name} is ${buf.length} bytes`);
  }
});

test('@font-face for Readex Pro: every weight, swap, relative urls, one script each', () => {
  const faces = css.match(/@font-face\s*\{[^}]*\}/g) || [];
  assert.strictEqual(faces.length, 3);
  for (const f of faces) {
    assert.match(f, /font-family:\s*"Readex Pro"/);
    assert.match(f, /font-weight:\s*160 700/);
    assert.match(f, /font-display:\s*swap/);
    assert.match(f, /src:\s*url\("fonts\/ReadexPro-(Arabic|Latin|LatinExt)\.woff2"\)\s*format\("woff2"\)/);
    assert.ok(!/https?:|\/\//.test(f.replace(/\/\*[\s\S]*?\*\//g, '')), 'no absolute urls');
  }
  const range = (file) => /unicode-range:\s*([^;]+);/.exec(faces.find((f) => f.includes(file)))[1];
  for (const r of ['U+0600-06FF', 'U+0750-077F', 'U+FB50-FDFF']) assert.ok(range('ReadexPro-Arabic').includes(r), r);
  assert.ok(range('ReadexPro-Latin.').startsWith('U+0000-00FF'));
  // Arabic letters only come from the Arabic file.
  assert.ok(!range('ReadexPro-Latin.').includes('U+06'));
  for (const f of FILES) assert.ok(fs.existsSync(path.join(root, 'renderer', 'fonts', f)), f);
});

test('Readex Pro is first in the text font stack and code fonts are untouched', () => {
  assert.match(css, /font:\s*14px\/1\.55 "Readex Pro", system-ui,/);
  const mono = css.match(/font-family:\s*ui-monospace[^;]*;/g) || [];
  assert.ok(mono.length >= 4);
  assert.ok(mono.every((m) => !m.includes('Readex')));
});

test('the font ships in the desktop and mobile builds, with its licence', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.files.includes('renderer/**/*'));
  const build = read('scripts', 'build-web.mjs');
  for (const f of [...FILES, 'OFL.txt']) assert.ok(build.includes(`renderer/fonts/${f}`), f);
  assert.match(read('renderer', 'fonts', 'OFL.txt'), /Copyright 2018 The Readex Pro Project Authors/);
  assert.match(read('THIRD-PARTY-NOTICES.md'), /Readex Pro.*SIL Open Font License 1\.1.*The Readex Pro Project Authors/);
});

test('the content security policies allow fonts from the app only', () => {
  const html = read('renderer', 'index.html');
  assert.match(html, /default-src 'self'/);
  assert.ok(!/font-src/.test(html) || /font-src 'self'/.test(html));
  const build = read('scripts', 'build-web.mjs');
  assert.match(build, /"default-src 'self'"/);
  assert.ok(!/font-src/.test(build) || /font-src 'self'/.test(build));
});
