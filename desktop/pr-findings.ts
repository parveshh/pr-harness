import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Citation } from '../shared/assistant.js';
import { finding, maxFindingLines, maxFindingChars, type Finding } from '../shared/findings.js';
import { excerpt } from './anchors.js';
import { excerptSource } from '../shared/suggestions.js';

export const findingsInstructions = `For the final review return only JSON with this shape:
{"coverage":"What you inspected and any material gaps","findings":[{"priority":"high|medium|low","title":"Short name for the defect","comment":"A standalone comment for the author explaining the trigger, impact, and a focused correction or test","startId":1,"endId":2,"suggestion":"Exact replacement text"}]}.
Use actual numeric diff evidence IDs for the first and last line of the smallest relevant range on one side of one hunk. Repeat the ID for one line. Limit the range to ${maxFindingLines} lines and ${maxFindingChars} characters. Use null for both IDs if there is no inline location. Never use source lookup IDs as diff anchors. Include "suggestion" only when the range is on the updated side of the diff and you are confident that the text is an exact drop-in replacement for those lines, with the same indentation and no diff markers. Otherwise omit it or use null. Describe broader or uncertain fixes in the comment instead. Write plain text in the comment without evidence tokens. Group symptoms of the same defect in one finding and order findings by impact. Return an empty findings list when there is no actionable defect. A lookup request can still precede the final report.`;

const evidenceId = z.number().int().positive().nullable();
const report = z.object({
  coverage: z.string().trim().min(1).max(6000),
  findings: z
    .array(
      z.object({
        priority: finding.shape.priority,
        title: z.string().trim().min(1).max(220),
        comment: z.string().trim().min(1).max(6000),
        startId: evidenceId,
        endId: evidenceId,
        // A malformed or oversized suggestion costs only the suggestion, never the finding.
        suggestion: z.string().nullish().catch(null),
      }),
    )
    .max(40),
});

// A suggestion only applies to new-side lines, and one that repeats the code adds nothing.
function suggestionFor(
  location: NonNullable<Finding['location']>,
  text: string | null | undefined,
) {
  if (location.side !== 'new' || !text || text.length > maxFindingChars) return undefined;
  const replacement = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return replacement && replacement !== excerptSource(location.excerpt).join('\n')
    ? replacement
    : undefined;
}

export function readFindings(answer: string, sources: Citation[], patch: (path: string) => string) {
  let value: unknown;
  try {
    value = JSON.parse(answer.trim().replace(/^`{3}(?:json)?\s*\n([\s\S]*?)\n`{3}$/i, '$1'));
  } catch {
    /* The schema below also handles a non-JSON response. */
  }
  const parsed = report.safeParse(value);
  if (!parsed.success)
    throw Error('The agent returned an unreadable findings report. Run Review PR again.');
  const byId = new Map(sources.map((c) => [c.id, c]));
  const findings = parsed.data.findings.map(
    ({ priority, title, comment, startId, endId, suggestion }): Finding => {
      const first = startId && byId.get(startId),
        last = endId && byId.get(endId);
      let location: Finding['location'] = null;
      if (
        first &&
        last &&
        first.path === last.path &&
        first.side === last.side &&
        first.hunk === last.hunk &&
        first.line <= last.line &&
        last.line - first.line < maxFindingLines
      ) {
        const anchor = {
          path: last.path,
          hunk: last.hunk,
          side: last.side,
          line: last.line,
          ...(first.line !== last.line && { startLine: first.line }),
        };
        const text = excerpt(patch(last.path), anchor, maxFindingChars);
        if (text !== undefined) location = { ...anchor, excerpt: text };
      }
      const replacement = location && suggestionFor(location, suggestion);
      return {
        id: randomUUID(),
        priority,
        title,
        comment,
        location,
        ...(replacement && { suggestion: replacement }),
        verdict: 'unreviewed',
        drafted: false,
      };
    },
  );
  return { coverage: parsed.data.coverage, findings };
}
