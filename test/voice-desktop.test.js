// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createVoice, cleanTranscript, WHISPER_MODELS } = require('../src/voice-desktop');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'balimda-voice-'));

test('cleanTranscript drops what Whisper "hears" in silence', () => {
  assert.strictEqual(cleanTranscript(' Hello there. '), 'Hello there.');
  assert.strictEqual(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.strictEqual(cleanTranscript(' (music) '), '');
  assert.strictEqual(cleanTranscript('ترجمة نانسي قنقر'), '');
  assert.strictEqual(cleanTranscript(' Thank you.'), '');
  assert.strictEqual(cleanTranscript('ما هي عاصمة فرنسا؟ [BLANK_AUDIO]'), 'ما هي عاصمة فرنسا؟');
});

test('a model download carries on after the connection drops', async () => {
  const data = crypto.randomBytes(300000);
  let connections = 0;
  const srv = http.createServer((req, res) => {
    connections++;
    const start = Number((req.headers.range || 'bytes=0-').match(/bytes=(\d+)-/)[1]);
    res.writeHead(start ? 206 : 200, { 'Content-Length': data.length - start });
    if (connections === 1) {
      res.write(data.subarray(0, 100000));
      setTimeout(() => res.destroy(), 50); // the connection drops
    } else {
      res.end(data.subarray(start));
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/ggml-test.bin`;
  const dir = tmp();
  const events = [];
  const model = WHISPER_MODELS[0];
  const realUrl = model.url;
  model.url = url;
  try {
    const voice = createVoice({ binDir: dir, modelsDir: dir, onEvent: (e) => events.push(e) });
    await voice.download(model.id);
    const done = events.find((e) => e.download.done);
    assert.strictEqual(done.download.error, undefined);
    assert.ok(fs.readFileSync(path.join(dir, 'ggml-test.bin')).equals(data), 'file is complete and identical');
    assert.strictEqual(connections, 2);
    assert.strictEqual(voice.status().models[0].downloaded, true);
    voice.deleteModel(model.id);
    assert.strictEqual(voice.status().models[0].downloaded, false);
  } finally {
    model.url = realUrl;
    srv.close();
  }
});

test('transcribe starts Whisper with the model and sends it the recording', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp();
  const model = WHISPER_MODELS[1];
  fs.writeFileSync(path.join(dir, path.basename(new URL(model.url).pathname)), 'model');
  // A stand-in for whisper-server: checks what it's given, answers like the real one.
  const fake = path.join(dir, 'whisper-server');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const http = require('http');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const model = args[args.indexOf('-m') + 1];
http.createServer((req, res) => {
  if (req.method === 'GET') return res.end('ok');
  let body = '';
  req.setEncoding('latin1');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const lang = body.match(/name="language"\\r\\n\\r\\n([^\\r]*)/)[1];
    const wav = body.includes('RIFF') && body.includes('WAVE');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: \` [\${lang}] \${wav ? 'wav' : 'no wav'} from \${require('path').basename(model)} \` }));
  });
}).listen(port, '127.0.0.1');
`);
  fs.chmodSync(fake, 0o755);
  const voice = createVoice({ binDir: dir, modelsDir: dir });
  try {
    const wav = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(100)]);
    const r1 = await voice.transcribe(wav, 'ar', 'small');
    assert.strictEqual(r1.text, '[ar] wav from ggml-small-q5_1.bin');
    const r2 = await voice.transcribe(wav, 'xx', 'small');
    assert.strictEqual(r2.text, '[auto] wav from ggml-small-q5_1.bin', 'unknown language -> auto, server reused');
    await assert.rejects(voice.transcribe(wav, 'en', 'turbo'), /Download the speech model first/);
  } finally {
    voice.stop();
  }
});
