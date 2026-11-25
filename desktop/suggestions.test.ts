import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendSuggestion,
  excerptSource,
  hasSuggestion,
  newSideLines,
  parseBody,
  suggestionFence,
} from '../shared/suggestions.js';

const text = (value: string) => ({ kind: 'text', text: value }) as const;
const suggestion = (...lines: string[]) => ({ kind: 'suggestion', lines }) as const;

await test('a body without a suggestion fence is prose, including other fenced code', () => {
  assert.deepEqual(parseBody(''), []);
  assert.deepEqual(parseBody('Just words.'), [text('Just words.')]);
  const code = 'Try:\n```ts\nconst a = 1;\n```';
  assert.deepEqual(parseBody(code), [text(code)]);
  assert.equal(hasSuggestion(code), false);
  // A suggestion fence quoted inside other code is not a suggestion.
  const quoted = '````md\n```suggestion\nx\n```\n````';
  assert.equal(hasSuggestion(quoted), false);
});

await test('one or several suggestion fences split the body around the prose', () => {
  assert.deepEqual(parseBody('Use this.\n\n```suggestion\nconst a = 2;\n```\n\nThanks.'), [
    text('Use this.'),
    suggestion('const a = 2;'),
    text('Thanks.'),
  ]);
  assert.deepEqual(parseBody('```suggestion\na\nb\n```\nthen\n```suggestion\nc\n```'), [
    suggestion('a', 'b'),
    text('then'),
    suggestion('c'),
  ]);
  // An empty fence deletes the lines. A blank line replaces them with an empty line.
  assert.deepEqual(parseBody('```suggestion\n```'), [suggestion()]);
  assert.deepEqual(parseBody('```suggestion\n\n```'), [suggestion('')]);
  assert.equal(hasSuggestion('x\n```suggestion\ny\n```'), true);
});

await test('longer fences hold backticks and CRLF bodies parse like LF bodies', () => {
  assert.deepEqual(parseBody('````suggestion\nconst s = ```x```;\n````'), [
    suggestion('const s = ```x```;'),
  ]);
  // A closing fence must be at least as long as the opening one.
  assert.deepEqual(parseBody('````suggestion\na\n```\nb\n````'), [suggestion('a', '```', 'b')]);
  assert.deepEqual(parseBody('Fix\r\n```suggestion\r\nnext\r\n  indented\r\n```\r\n'), [
    text('Fix'),
    suggestion('next', '  indented'),
  ]);
});

await test('an unterminated fence stays prose', () => {
  const open = 'Maybe\n```suggestion\nnever closed';
  assert.deepEqual(parseBody(open), [text(open)]);
  assert.equal(hasSuggestion(open), false);
  // A short closing fence does not close a longer opening one.
  const short = '````suggestion\nx\n```';
  assert.equal(hasSuggestion(short), false);
  // Later complete fences still count when an earlier one is broken.
  assert.deepEqual(parseBody('```suggestion\nx'), [text('```suggestion\nx')]);
});

await test('suggestion fences outgrow backticks in the replacement and keep the draft text', () => {
  assert.equal(suggestionFence(['a']), '```suggestion\na\n```');
  assert.equal(suggestionFence(['`x`', '```y```']), '````suggestion\n`x`\n```y```\n````');
  const empty = appendSuggestion('', ['one', 'two']);
  assert.equal(empty.body, '```suggestion\none\ntwo\n```');
  assert.equal(empty.body.slice(0, empty.caret), '```suggestion\none\ntwo');
  const kept = appendSuggestion('Please change this.\n', ['one']);
  assert.equal(kept.body, 'Please change this.\n\n```suggestion\none\n```');
  assert.equal(kept.body.slice(kept.caret), '\n```');
  assert.deepEqual(parseBody(kept.body), [text('Please change this.'), suggestion('one')]);
  assert.deepEqual(parseBody(appendSuggestion('', ['```y```']).body), [suggestion('```y```')]);
});

await test('new-side source comes from the hunk and excludes removed lines', () => {
  const hunk = '@@ -4,3 +4,3 @@\n keep\n-gone\n+added\n+extra\n tail';
  assert.deepEqual(newSideLines(hunk, { line: 5 }), ['added']);
  assert.deepEqual(newSideLines(hunk, { startLine: 4, line: 6 }), ['keep', 'added', 'extra']);
  assert.equal(newSideLines(hunk, { startLine: 7, line: 9 }), null);
  assert.equal(newSideLines(hunk, { startLine: 6, line: 5 }), null);
  assert.deepEqual(excerptSource('+added\n+extra'), ['added', 'extra']);
  assert.deepEqual(excerptSource(''), []);
});
