// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Checks voice chat's speech recognition on the computer for real: downloads
// each Whisper model the app offers and has the Whisper built by
// scripts/build-whisper.js transcribe a recording, through the same code the
// app uses (src/voice-desktop.js). Used by .github/workflows/model-links.yml.
//   node scripts/whisper-smoke.js <recording.wav> "<words it must contain>"

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVoice, WHISPER_MODELS } = require('../src/voice-desktop');

const [wavPath, expected] = process.argv.slice(2);
const osName = { win32: 'win', darwin: 'mac' }[process.platform] || 'linux';
const voice = createVoice({
  binDir: path.join(__dirname, '..', 'whisper-bin', `${osName}-${process.arch}`),
  modelsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-models-')),
  onEvent: (e) => { if (e.download.done) console.log(`downloaded ${e.download.id}: ${e.download.error || 'ok'}`); }
});

(async () => {
  let failed = false;
  const wav = fs.readFileSync(wavPath);
  for (const m of WHISPER_MODELS) {
    await voice.download(m.id);
    const t0 = Date.now();
    const first = await voice.transcribe(wav, 'en', m.id).catch((err) => ({ error: err.message }));
    const t1 = Date.now();
    const again = await voice.transcribe(wav, 'auto', m.id).catch((err) => ({ error: err.message }));
    const ok = !first.error && first.text.toLowerCase().includes(expected.toLowerCase()) && !again.error && again.text;
    if (!ok) failed = true;
    console.log(`${ok ? '✓' : '✗'} ${m.name}: "${first.text || first.error}" (${((t1 - t0) / 1000).toFixed(1)} s with loading, ` +
      `${((Date.now() - t1) / 1000).toFixed(1)} s loaded; language found automatically: "${again.text || again.error}")`);
    voice.deleteModel(m.id);
  }
  voice.stop();
  if (failed) process.exit(1);
})();
