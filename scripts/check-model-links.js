// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Checks that every model in the phone catalogs can be downloaded and is
// about the size the app shows. Run by .github/workflows/model-links.yml.
//   node scripts/check-model-links.js

const fs = require('fs');
const path = require('path');

const FILES = ['mobile/src/native-engine.js', 'mobile/src/on-device.js'];

function catalog(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const list = src.slice(src.indexOf('export const CATALOG'), src.indexOf('];', src.indexOf('export const CATALOG')));
  const out = [];
  const entry = /name:\s*'([^']+)'[\s\S]*?size:\s*([\d.e]+)[\s\S]*?url:\s*'([^']+)'/g;
  let m;
  while ((m = entry.exec(list))) out.push({ name: m[1], size: Number(m[2]), url: m[3] });
  return out;
}

async function sizeOf(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const len = Number(res.headers.get('content-length'));
      return len > 0 ? { size: len } : { error: 'no size' };
    } catch (err) {
      if (attempt >= 3) return { error: err.message };
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

(async () => {
  let failed = 0;
  for (const file of FILES) {
    const models = catalog(file);
    console.log(`${file}: ${models.length} models`);
    for (const m of models) {
      const r = await sizeOf(m.url);
      let status = 'ok';
      if (r.error) status = `BROKEN (${r.error})`;
      else if (Math.abs(r.size - m.size) / r.size > 0.1) status = `WRONG SIZE (listed ${(m.size / 1e9).toFixed(2)} GB)`;
      if (status !== 'ok') failed++;
      console.log(`  ${status === 'ok' ? '✓' : '✗'} ${m.name}: ${r.size ? (r.size / 1e9).toFixed(3) + ' GB' : '-'} ${status === 'ok' ? '' : status}`);
    }
  }
  if (failed) {
    console.error(`${failed} model link(s) need fixing.`);
    process.exit(1);
  }
})();
