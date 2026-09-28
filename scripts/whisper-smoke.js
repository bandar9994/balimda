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

// The first `seconds` of a 16 kHz mono 16-bit WAV, as a plain WAV like the app records.
function cut(wav, seconds) {
  const data = wav.indexOf('data', 12);
  const samples = wav.subarray(data + 8, data + 8 + wav.readUInt32LE(data + 4));
  const pcm = samples.subarray(0, Math.min(samples.length, Math.round(seconds * 16000) * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
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
    const clip = cut(wav, 60); // as the app records it
    const full = await timed(() => voice.transcribe(clip, 'en', m.id, { fullWindow: true }));
    const sized = await timed(() => voice.transcribe(clip, 'en', m.id));
    const short = await timed(() => voice.transcribe(cut(wav, 3), 'en', m.id)); // "And so my fellow Americans"
    const auto = await timed(() => voice.transcribe(clip, 'auto', m.id));
    const ok = !load.error && [full, sized, auto].every((r) => !r.error && r.text.toLowerCase().includes(expected.toLowerCase())) && !short.error && short.text;
    if (!ok) failed = true;
    console.log(`${ok ? '✓' : '✗'} ${m.name} (${os.cpus().length} CPU threads; starting it: ${load.s} s)`);
    for (const [label, r] of [['30 s window', full], ['window sized to the recording', sized], ['a 3 s phrase', short], ['language found automatically', auto]]) {
      console.log(`    ${label}: ${r.s} s  "${r.text || r.error}"`);
    }
    voice.deleteModel(m.id);
  }
  voice.stop();
  if (failed) process.exit(1);
})();
