import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit, SKIP } from 'unist-util-visit';

const parser = unified().use(remarkParse).use(remarkGfm);

// Edit original source spans so that stored code, escapes and Markdown formatting stay intact.
export function replaceCitations(source: string, replace: (id: number, marker: string) => string) {
  if (!source.includes('[[')) return source;
  let cursor = 0;
  const parts: string[] = [];
  visit(parser.parse(source), (node) => {
    if (node.type === 'link' || node.type === 'linkReference') return SKIP;
    if (node.type !== 'text' || !node.position) return;
    const start = node.position.start.offset,
      end = node.position.end.offset;
    if (start === undefined || end === undefined) return;
    for (const match of source.slice(start, end).matchAll(/(\\*)\[\[(\d+)\]\]/g)) {
      const escapes = match[1]?.length ?? 0;
      if (escapes % 2) continue;
      const index = start + match.index + escapes;
      const marker = match[0].slice(escapes);
      parts.push(source.slice(cursor, index), replace(Number(match[2]), marker));
      cursor = index + marker.length;
    }
  });
  return parts.join('') + source.slice(cursor);
}
