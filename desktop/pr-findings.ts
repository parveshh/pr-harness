import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Citation } from '../shared/assistant.js';
import { finding, maxFindingLines, maxFindingChars, type Finding } from '../shared/findings.js';
import { excerpt } from './anchors.js';

export const findingsInstructions = `For the final review return only JSON with this shape:
{"coverage":"What you inspected and any material gaps","findings":[{"priority":"high|medium|low","title":"Short name for the defect","comment":"A standalone comment for the author explaining the trigger, impact, and a focused correction or test","startId":1,"endId":2}]}.
Use actual numeric diff evidence IDs for the first and last line of the smallest relevant range on one side of one hunk. Repeat the ID for one line. Limit the range to ${maxFindingLines} lines and ${maxFindingChars} characters. Use null for both IDs if there is no inline location. Never use source lookup IDs as diff anchors. Write plain text in the comment without evidence tokens. Group symptoms of the same defect in one finding and order findings by impact. Return an empty findings list when there is no actionable defect. A lookup request can still precede the final report.`;

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
      }),
    )
    .max(40),
});

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
    ({ priority, title, comment, startId, endId }): Finding => {
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
      return {
        id: randomUUID(),
        priority,
        title,
        comment,
        location,
        verdict: 'unreviewed',
        drafted: false,
      };
    },
  );
  return { coverage: parsed.data.coverage, findings };
}
