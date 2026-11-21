import { common, createLowlight } from 'lowlight';
import type { diffLines } from './diff.js';

type Row = ReturnType<typeof diffLines>['lines'][number];
// `kind` carries highlight.js class names such as "hljs-keyword".
export type Token = { text: string; kind: string | null };
// The parts of a hast node this module reads. Other node types carry no source text.
type Node = {
  type: string;
  value?: unknown;
  properties?: { className?: unknown };
  children?: Node[];
};

const lowlight = createLowlight(common);
// Extensions that highlight.js does not list as an alias of a bundled grammar.
// Maps, because a file can be named after an Object.prototype key such as "constructor".
const byExtension = new Map([
  ['tsx', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['jsx', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['htm', 'xml'],
  ['svg', 'xml'],
  ['vue', 'xml'],
  ['jsonc', 'json'],
  ['zsh', 'bash'],
  ['toml', 'ini'],
  ['h', 'c'],
  ['hpp', 'cpp'],
  ['mdx', 'markdown'],
]);
const byName = new Map([
  ['makefile', 'makefile'],
  ['gnumakefile', 'makefile'],
]);
// Highlighting runs while rendering, so keep the worst case short.
const maxCharacters = 150_000,
  maxLineLength = 2_000;

export function languageFor(path: string): string | null {
  const name = path.split('/').at(-1)?.toLowerCase() ?? '';
  const extension = name.includes('.') ? (name.split('.').at(-1) ?? '') : '';
  const language = byName.get(name) ?? byExtension.get(extension) ?? extension;
  return language && lowlight.registered(language) ? language : null;
}

function tokenLines(language: string, source: string): Token[][] {
  const lines: Token[][] = [[]];
  function walk(node: Node, kind: string | null) {
    if (node.type === 'text' && typeof node.value === 'string') {
      for (const [index, text] of node.value.split('\n').entries()) {
        if (index) lines.push([]);
        if (text) lines.at(-1)?.push({ text, kind });
      }
    } else if (node.type === 'element') {
      const names = node.properties?.className;
      const own = Array.isArray(names) ? names.filter((n) => typeof n === 'string').join(' ') : '';
      for (const child of node.children ?? []) walk(child, own || kind);
    }
  }
  for (const child of lowlight.highlight(language, source).children) walk(child, null);
  return lines;
}

// Highlight each side of a hunk as continuous source so strings and comments that span
// lines keep their colour, then hand every row the tokens for its own line. A row that
// cannot be highlighted gets null and renders as plain text.
export function highlightRows(rows: Row[], language: string | null): (Token[] | null)[] {
  const plain = rows.map(() => null);
  if (!language || !lowlight.registered(language)) return plain;
  let size = 0;
  for (const row of rows) {
    size += row.text.length;
    if (row.text.length > maxLineLength || size > maxCharacters) return plain;
  }
  const result: (Token[] | null)[] = [...plain];
  for (const side of ['oldLine', 'newLine'] as const) {
    const own = side === 'oldLine' ? 'deletion' : 'addition';
    const indexes = rows.flatMap((row, index) => (row[side] === null ? [] : [index]));
    // A new or deleted file has rows on one side only.
    if (!indexes.length) continue;
    let lines: Token[][];
    try {
      lines = tokenLines(language, indexes.map((i) => rows[i]?.text.slice(1) ?? '').join('\n'));
    } catch {
      return plain;
    }
    if (lines.length !== indexes.length) return plain;
    for (const [position, index] of indexes.entries()) {
      const row = rows[index];
      // Context rows appear on both sides. Show them as they read after the change.
      if (row && (row.kind === own || (row.kind === 'context' && side === 'newLine')))
        result[index] = lines[position] ?? null;
    }
  }
  return result;
}
