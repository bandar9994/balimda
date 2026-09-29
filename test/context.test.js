// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '../mobile/src/context.js')).href);

test('on-device context: Arabic counts as more tokens than English of the same length', async () => {
  const { estimateTokens } = await load();
  assert.strictEqual(estimateTokens('abcdef'), 2);
  assert.ok(estimateTokens('مرحبا بك في الرياض') > estimateTokens('Welcome to Riyadh!'));
});

test('on-device context: keeps the newest messages that fit, starting with the user', async () => {
  const { fitToContext } = await load();
  const long = 'كيف أروح بأقل سعر تذكرة من الرياض '.repeat(40);
  const messages = [];
  for (let i = 0; i < 20; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: `${i} ${long}` });
  const kept = fitToContext(messages, 'Be brief.', 4096, 2048);
  assert.ok(kept.length > 0 && kept.length < messages.length);
  assert.strictEqual(kept[0].role, 'user');
  assert.strictEqual(kept.at(-1), messages.at(-1));
  // The trimmed chat really fits: about 1 token per 1.5 Arabic letters.
  const letters = kept.reduce((n, m) => n + m.content.length, 0);
  assert.ok(letters / 1.5 < 4096 - 2048);
  // A short chat is kept whole.
  const short = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'how are you' }];
  assert.deepStrictEqual(fitToContext(short, '', 4096, 1024), short);
});

test('on-device context: a picture counts as many tokens', async () => {
  const { fitToContext, PICTURE_TOKENS } = await load();
  const pic = 'data:image/jpeg;base64,AAAA';
  const messages = [
    { role: 'user', content: 'old', images: [pic, pic] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'new', images: [pic] }
  ];
  // Room for one picture, not three.
  const kept = fitToContext(messages, '', PICTURE_TOKENS * 2 + 300, 0);
  assert.deepStrictEqual(kept, [messages[2]]);
  assert.strictEqual(fitToContext(messages, '', PICTURE_TOKENS * 4, 0).length, 3);
});
