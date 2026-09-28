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

// The first `seconds` of a 16 kHz mono WAV, as a WAV.
function cut(wav, seconds) {
  const bytes = Math.min(wav.length - 44, Math.round(seconds * 16000) * 2);
  const out = Buffer.concat([wav.subarray(0, 44), wav.subarray(44, 44 + bytes)]);
  out.writeUInt32LE(36 + bytes, 4);
  out.writeUInt32LE(bytes, 40);
  return out;
}

const timed = async (fn) => {
  const t0 = Date.now();
  const r = await fn().catch((err) => ({ text: '', error: err.message }));
  return { ...r, s: ((Date.now() - t0) / 1000).toFixed(1) };
};

(async () => {
  let failed = false;
  const wav = fs.readFileSync(wavPath);
  for (const m of WHISPER_MODELS) {
    await voice.download(m.id);
    const load = await timed(() => voice.transcribe(cut(wav, 2), 'en', m.id));
    const full = await timed(() => voice.transcribe(wav, 'en', m.id, { fullWindow: true }));
    const sized = await timed(() => voice.transcribe(wav, 'en', m.id));
    const short = await timed(() => voice.transcribe(cut(wav, 4), 'en', m.id));
    const auto = await timed(() => voice.transcribe(wav, 'auto', m.id));
    const ok = [full, sized, auto].every((r) => !r.error && r.text.toLowerCase().includes(expected.toLowerCase())) && short.text;
    if (!ok) failed = true;
    console.log(`${ok ? '✓' : '✗'} ${m.name} (${os.cpus().length} CPU threads; starting it: ${load.s} s)`);
    for (const [label, r] of [['30 s window', full], ['window sized to the recording', sized], ['a 4 s phrase', short], ['language found automatically', auto]]) {
      console.log(`    ${label}: ${r.s} s  "${r.text || r.error}"`);
    }
    voice.deleteModel(m.id);
  }
  voice.stop();
  if (failed) process.exit(1);
})();
