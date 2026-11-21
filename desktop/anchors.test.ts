import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relocate } from './anchors.js';

await test('a draft on a deleted line follows the moved deletion and stays put when the deletion is reverted', () => {
  const before = '@@ -1,4 +1,3 @@\n a\n-gone\n b\n c';
  const draft = {
    id: 'draft',
    body: 'Why remove this?',
    path: 'f.ts',
    side: 'old' as const,
    hunk: 0,
    line: 2,
    revision: 'base...one',
    excerpt: '-gone',
  };
  assert.deepEqual(relocate(draft, before, '@@ -3,4 +3,3 @@\n a\n-gone\n b\n c', false), {
    path: 'f.ts',
    side: 'old',
    hunk: 0,
    line: 4,
  });
  assert.equal(relocate(draft, before, '@@ -1,4 +1,5 @@\n a\n gone\n b\n c\n+d', false), null);
});
