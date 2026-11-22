import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit, SKIP } from 'unist-util-visit';

const parser = unified().use(remarkParse).use(remarkGfm);

// Edit original source spans so that stored code, escapes and Markdown formatting stay intact.
export function citationMarkers(source: string) {
  const markers: { id: number; start: number; end: number }[] = [];
  if (!source.includes('[[')) return markers;
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
      markers.push({ id: Number(match[2]), start: index, end: index + marker.length });
    }
  });
  return markers;
}

export function replaceCitations(source: string, replace: (id: number, marker: string) => string) {
  let cursor = 0;
  const parts: string[] = [];
  for (const { id, start, end } of citationMarkers(source)) {
    parts.push(source.slice(cursor, start), replace(id, source.slice(start, end)));
    cursor = end;
  }
  return parts.join('') + source.slice(cursor);
}
