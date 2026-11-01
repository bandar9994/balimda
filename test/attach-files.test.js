// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

const test = require('node:test');
const assert = require('node:assert');
const { readTextFile, decodeText, fileBlock, filesOf, formatSize, MAX_CHARS } = require('../renderer/attach-files.js');

const file = (name, data, type = '') => new File([data], name, { type });

test('text and code files are read, with their name and size', async () => {
  const md = await readTextFile(file('notes.md', '# Plan\n- ship it\n', 'text/markdown'));
  assert.deepStrictEqual(md.file, { name: 'notes.md', size: 17, text: '# Plan\n- ship it\n' });
  const py = await readTextFile(file('app.py', 'def hi():\n    print("مرحبا")\n'));   // no type at all, Arabic inside
  assert.strictEqual(py.file.text, 'def hi():\n    print("مرحبا")\n');
  // A byte-order mark is dropped; an older encoding is still read.
  assert.strictEqual(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi');
  assert.strictEqual(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9])), 'café');
});

test('anything that isn\'t text is turned down with a reason, and a huge file is cut', async () => {
  const pdf = await readTextFile(file('report.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 3, 0, 0])));
  assert.match(pdf.error, /report\.pdf isn't a text file/);
  const noise = new Uint8Array(4000).map((_, i) => (i * 7) % 32);  // control bytes, no zeros
  noise[0] = 1;
  assert.match((await readTextFile(file('blob.bin', noise.map((b) => b || 1)))).error, /isn't a text file/);
  const big = await readTextFile(file('log.txt', 'a'.repeat(MAX_CHARS + 10)));
  assert.strictEqual(big.file.text.length, MAX_CHARS);
  assert.strictEqual(big.file.cut, true);
});

test('what the model reads: each file in its own block, shorter when asked', () => {
  const f = { name: 'a "b".js', size: 12, text: 'const x = 1;' };
  assert.strictEqual(fileBlock(f), '<file name="a \'b\'.js">\nconst x = 1;\n</file>');
  assert.strictEqual(fileBlock(f, 5), '<file name="a \'b\'.js">\nconst\n[… the rest of the file was left out: it is too long]\n</file>');
  assert.deepStrictEqual(filesOf({ files: [f, { name: 1 }, null] }), [f]);
  assert.deepStrictEqual(filesOf({}), []);
  assert.strictEqual(formatSize(900), '900 B');
  assert.strictEqual(formatSize(4300), '4 KB');
});
