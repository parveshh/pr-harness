// Each hunk has its own old/new line counters. A deletion never consumes a head line.
export function hunkLineCounter(heading: string) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(heading);
  let before = Number(match?.[1] ?? 0),
    after = Number(match?.[2] ?? 0);
  return (text: string) => {
    const marker = text[0],
      oldLine = marker === ' ' || marker === '-' ? before++ : null,
      newLine = marker === ' ' || marker === '+' ? after++ : null;
    return {
      text,
      oldLine,
      newLine,
      kind: marker === '+' ? 'addition' : marker === '-' ? 'deletion' : 'context',
    };
  };
}
export function diffLines(hunk: string) {
  const [heading = '', ...body] = hunk.split('\n');
  return { heading, lines: body.map(hunkLineCounter(heading)) };
}
