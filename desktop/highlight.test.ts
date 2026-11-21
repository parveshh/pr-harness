import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLines } from '../shared/diff.js';
import { highlightRows, languageFor } from '../shared/highlight.js';

await test('a language is chosen from the file name, and unknown files stay plain', () => {
  assert.equal(languageFor('client/src/Reader.tsx'), 'typescript');
  assert.equal(languageFor('scripts/desktop-smoke.mjs'), 'javascript');
  assert.equal(languageFor('api/server.PY'), 'py');
  assert.equal(languageFor('Makefile'), 'makefile');
  assert.equal(languageFor('assets/logo.png'), null);
  assert.equal(languageFor('LICENSE'), null);
  for (const name of ['constructor', 'x.constructor', 'a/x.__proto__', 'toString', '.gitignore'])
    assert.equal(languageFor(name), null);
});

await test('every highlighted row keeps its exact text, and each side is read as continuous source', () => {
  const { lines } = diffLines(
    [
      '@@ -1,4 +1,5 @@',
      ' const total = 1;',
      '-/* old',
      '-   note */',
      '+const text = `first',
      '+second ${total}`;',
      '+return text;',
      ' export {};',
      '\\ No newline at end of file',
    ].join('\n'),
  );
  const rows = highlightRows(lines, 'typescript');
  for (const [index, tokens] of rows.entries()) {
    const line = lines[index];
    assert.ok(line);
    if (line.oldLine === null && line.newLine === null) assert.equal(tokens, null);
    else assert.equal(tokens?.map((t) => t.text).join(''), line.text.slice(1));
  }
  const kinds = (index: number) => rows[index]?.map((t) => t.kind);
  assert.deepEqual(rows[0]?.[0], { text: 'const', kind: 'hljs-keyword' });
  // The second line of a block comment or template string is coloured from its first line.
  assert.deepEqual(kinds(2), ['hljs-comment']);
  assert.equal(rows[4]?.[0]?.kind, 'hljs-string');
  assert.equal(rows[5]?.[0]?.kind, 'hljs-keyword');
});

await test('hunks with only additions or only deletions are highlighted', () => {
  for (const marker of ['+', '-']) {
    const range = marker === '+' ? '-0,0 +1,2' : '-1,2 +0,0';
    const { lines } = diffLines('@@ ' + range + ' @@\n' + marker + '/* a\n' + marker + 'b */');
    assert.deepEqual(highlightRows(lines, 'typescript'), [
      [{ text: '/* a', kind: 'hljs-comment' }],
      [{ text: 'b */', kind: 'hljs-comment' }],
    ]);
  }
});

await test('unknown languages and oversized hunks are left unhighlighted', () => {
  const { lines } = diffLines('@@ -1 +1 @@\n-const a = 1;\n+const a = 2;');
  assert.deepEqual(highlightRows(lines, null), [null, null]);
  assert.deepEqual(highlightRows(lines, 'not-a-language'), [null, null]);
  const long = diffLines('@@ -0,0 +1 @@\n+const a = "' + 'x'.repeat(6000) + '";').lines;
  assert.deepEqual(highlightRows(long, 'typescript'), [null]);
  const many = diffLines(
    '@@ -0,0 +1,200 @@\n' + Array.from({ length: 200 }, () => '+' + 'y'.repeat(1000)).join('\n'),
  ).lines;
  assert.ok(highlightRows(many, 'typescript').every((row) => row === null));
});
