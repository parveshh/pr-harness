export function diffLines(hunk: string) {
  const [heading = '', ...body] = hunk.split('\n');
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(heading);
  let before = Number(match?.[1] ?? 0),
    after = Number(match?.[2] ?? 0);
  return {
    heading,
    lines: body.map((text) => {
      const marker = text[0],
        oldLine = marker === ' ' || marker === '-' ? before++ : null,
        newLine = marker === ' ' || marker === '+' ? after++ : null;
      return {
        text,
        oldLine,
        newLine,
        kind: marker === '+' ? 'addition' : marker === '-' ? 'deletion' : 'context',
      };
    }),
  };
}
