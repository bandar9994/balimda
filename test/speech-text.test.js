// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

const test = require('node:test');
const assert = require('node:assert');
const { languageOf, speakable, nextChunk } = require('../renderer/speech-text.js');

test('languageOf picks the script most letters are in', () => {
  assert.strictEqual(languageOf('مرحبا، كيف حالك؟'), 'ar');
  assert.strictEqual(languageOf('Hello there'), 'en');
  assert.strictEqual(languageOf('استخدم Python لهذا المشروع'), 'ar');
  assert.strictEqual(languageOf('12345', 'ar'), 'ar');
});

test('speakable drops Markdown, links, code and emoji', () => {
  const md = [
    '# Trip plan',
    '',
    'Here is **the best** way, see [this guide](https://example.com/x) 🙂',
    '',
    '- Book *early*',
    '- Compare prices at https://flights.example.com',
    '',
    '```python',
    'print("hi")',
    '```',
    '',
    '| City | Price |',
    '|------|------:|',
    '| NYC | 400 |',
    '> Have fun'
  ].join('\n');
  assert.strictEqual(speakable(md),
    'Trip plan. Here is the best way, see this guide. Book early. Compare prices at. City, Price. NYC, 400. Have fun.');
});

test('speakable keeps Arabic punctuation and adds pauses between lines', () => {
  assert.strictEqual(speakable('أهلاً بك؟\nهذه قائمة\n1. الأول'), 'أهلاً بك؟ هذه قائمة. الأول.');
  assert.strictEqual(speakable('snake_case and 2 * 3 * 4'), 'snake_case and 2 * 3 * 4.');
});

test('nextChunk reads finished sentences while the reply is written', () => {
  let text = 'The capital of France is Paris';
  assert.strictEqual(nextChunk(text, 0, false), null); // no sentence end yet
  text += '. It is known for the Eiffel Tower. It';
  const c = nextChunk(text, 0, false);
  assert.strictEqual(c.chunk, 'The capital of France is Paris. It is known for the Eiffel Tower.');
  assert.strictEqual(nextChunk(text, c.next, false), null);
  const last = nextChunk(text + ' has great food', c.next, true);
  assert.strictEqual(last.chunk.trim(), 'It has great food');
  assert.strictEqual(nextChunk('3.5 kg', 0, false), null); // a decimal point isn't a sentence end
});

test('nextChunk waits for short pieces and unfinished code blocks', () => {
  assert.strictEqual(nextChunk('Yes. ', 0, false), null);
  assert.strictEqual(nextChunk('Yes. ', 0, true).chunk, 'Yes. ');
  const text = 'Run this command in your terminal first.\n```bash\nls -la. more';
  const c = nextChunk(text, 0, false);
  assert.strictEqual(c.chunk, 'Run this command in your terminal first.\n');
  assert.strictEqual(nextChunk(text, c.next, false), null);
});

test('nextChunk doesn\'t end a sentence at a list number', () => {
  const text = 'Here is a plan for your trip:\n\n1. Book your flight early.\n2. ';
  const c = nextChunk(text, 0, false);
  assert.strictEqual(c.chunk, 'Here is a plan for your trip:\n\n1. Book your flight early.\n');
  assert.strictEqual(nextChunk(text, c.next, false), null);
});

test('nextChunk handles Arabic sentence ends', () => {
  const text = 'مرحباً! كيف يمكنني مساعدتك اليوم في رحلتك؟ ';
  assert.strictEqual(nextChunk(text, 0, false).chunk, 'مرحباً! كيف يمكنني مساعدتك اليوم في رحلتك؟');
});
