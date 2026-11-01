// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

// Builds the mobile web app into www/ for Capacitor (Android / iOS).
// It reuses the desktop UI from renderer/ and swaps the Electron bridge for
// the mobile one in mobile/src/bridge.js.
//
//   node scripts/build-web.mjs

import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www');
const r = (...p) => path.join(root, ...p);

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(path.join(out, 'vendor'), { recursive: true });
await fs.mkdir(path.join(out, 'wllama'), { recursive: true });
await fs.mkdir(path.join(out, 'fonts'), { recursive: true });

await Promise.all([
  fs.copyFile(r('renderer/app.js'), path.join(out, 'app.js')),
  fs.copyFile(r('renderer/i18n.js'), path.join(out, 'i18n.js')),
  fs.copyFile(r('renderer/i18n-ar.js'), path.join(out, 'i18n-ar.js')),
  fs.copyFile(r('renderer/store-flags.js'), path.join(out, 'store-flags.js')),
  fs.copyFile(r('renderer/report.js'), path.join(out, 'report.js')),
  fs.copyFile(r('renderer/speech-text.js'), path.join(out, 'speech-text.js')),
  fs.copyFile(r('renderer/attach-files.js'), path.join(out, 'attach-files.js')),
  fs.copyFile(r('renderer/save-queue.js'), path.join(out, 'save-queue.js')),
  fs.copyFile(r('src/lease.js'), path.join(out, 'lease.js')),
  fs.copyFile(r('renderer/styles.css'), path.join(out, 'styles.css')),
  fs.copyFile(r('renderer/fonts/ReadexPro-Arabic.woff2'), path.join(out, 'fonts/ReadexPro-Arabic.woff2')),
  fs.copyFile(r('renderer/fonts/OFL.txt'), path.join(out, 'fonts/OFL.txt')),
  fs.copyFile(r('build/icon.png'), path.join(out, 'icon.png')),
  fs.copyFile(r('LICENSE'), path.join(out, 'LICENSE.txt')),
  fs.copyFile(r('THIRD-PARTY-NOTICES.md'), path.join(out, 'THIRD-PARTY-NOTICES.md')),
  fs.copyFile(r('node_modules/marked/lib/marked.umd.js'), path.join(out, 'vendor/marked.umd.js')),
  fs.copyFile(r('node_modules/dompurify/dist/purify.min.js'), path.join(out, 'vendor/purify.min.js')),
  fs.copyFile(r('node_modules/@wllama/wllama/esm/wasm/wllama.wasm'), path.join(out, 'wllama/wllama.wasm'))
]);

await build({
  entryPoints: [r('mobile/src/bridge.js')],
  outfile: path.join(out, 'bridge.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome100', 'safari16'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  banner: { js: '/*! Najwa AI — © 2026 Bandar Altariqi. All rights reserved. Najwa AI License (non-commercial; keep the Najwa AI name and "Najwa AI by Bandar Altariqi" credit; no rebranding). Includes third-party software under their own licenses; see THIRD-PARTY-NOTICES.md. */' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning'
});

// Same page as desktop, with mobile paths, the mobile bridge and a CSP that
// allows WebAssembly (on-device models) and connections to any model server.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "connect-src * data: blob:",
  "object-src 'none'",
  "base-uri 'none'"
].join('; ');

let html = await fs.readFile(r('renderer/index.html'), 'utf8');
const replace = (from, to) => {
  if (!html.includes(from)) throw new Error(`build-web: could not find ${from} in renderer/index.html`);
  html = html.replace(from, to);
};
replace(/content="default-src[^"]*"/.exec(html)[0], `content="${csp}"`);
// No zooming on phones: like a native app, a double tap or pinch shouldn't
// zoom the whole app (iPhone does both unless told not to).
replace('content="width=device-width, initial-scale=1"', 'content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content"');
replace('../node_modules/marked/lib/marked.umd.js', 'vendor/marked.umd.js');
replace('../node_modules/dompurify/dist/purify.min.js', 'vendor/purify.min.js');
replace('../src/lease.js', 'lease.js');
replace('<script src="app.js"></script>', '<script src="bridge.js"></script>\n  <script src="app.js"></script>');
replace('<title>Najwa AI</title>', '<title>Najwa AI</title>\n  <meta name="theme-color" content="#5b5bd6" />\n  <link rel="icon" href="icon.png" />');
await fs.writeFile(path.join(out, 'index.html'), html);

console.log('Built mobile web app into www/');
