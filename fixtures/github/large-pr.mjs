// Fixture responses for a pull request large enough to stress the reader: thousands of changed
// files, one added generated file that is a single hunk, and a modified file with a long hunk
// that carries a published review thread. The desktop test and `npm run bench:large` share it.
export const largePr = {
  url: 'https://github.com/example/large/pull/7',
  addedPath: 'generated/routes.ts',
  modifiedPath: 'src/ledger.ts',
  thread: { line: 8, body: 'Does this total still include refunds?' },
};
const endpointPrefix = 'repos/example/large/';
const base = 'a'.repeat(40),
  head = 'c'.repeat(40);

export const addedLine = (n) => 'export const route' + n + " = '/items/" + n + "';";

function addedFile(lines) {
  return {
    filename: largePr.addedPath,
    status: 'added',
    additions: lines,
    deletions: 0,
    sha: 'large-added-' + lines,
    patch:
      '@@ -0,0 +1,' +
      lines +
      ' @@\n' +
      Array.from({ length: lines }, (_, i) => '+' + addedLine(i + 1)).join('\n'),
  };
}

// Every block of five rows is three context lines, a removal and its replacement, so both
// sides of the hunk number the same lines. A block comment spans the first rows.
function modifiedFile(rows) {
  const body = [];
  let lines = 0,
    changed = 0;
  for (let row = 0; body.length < rows; row++) {
    if (row % 4 === 3) {
      body.push('-  total += entry(' + row + ');', '+  total += settled(' + row + ');');
      changed++;
    } else
      body.push(
        row === 0
          ? ' /* Ledger totals,'
          : row === 1
            ? '    one entry per row. */'
            : ' step' + row + '();',
      );
    lines++;
  }
  return {
    filename: largePr.modifiedPath,
    status: 'modified',
    additions: changed,
    deletions: changed,
    sha: 'large-modified-' + rows,
    patch: '@@ -1,' + lines + ' +1,' + lines + ' @@\n' + body.join('\n'),
  };
}

function smallFile(n) {
  const folder = 'packages/pkg-' + String(n % 60).padStart(2, '0');
  const path =
    folder + (n % 3 ? '/src' : '/test') + '/module-' + String(n).padStart(4, '0') + '.ts';
  return {
    filename: path,
    status: n % 7 ? 'modified' : 'added',
    additions: 1,
    deletions: n % 7 ? 1 : 0,
    sha: 'large-small-' + n,
    patch:
      n % 7
        ? '@@ -1 +1 @@\n-export const value = ' + (n - 1) + ';\n+export const value = ' + n + ';'
        : '@@ -0,0 +1 @@\n+export const value = ' + n + ';',
  };
}

// `shape` is { files, addedLines, modifiedRows }. Returns undefined for other endpoints.
export function largePrFixture(endpoint, shape) {
  if (!endpoint.startsWith(endpointPrefix)) return undefined;
  const rest = endpoint.slice(endpointPrefix.length);
  if (rest === 'pulls/7')
    return {
      title: 'Regenerate routes and settle the ledger',
      created_at: '2026-11-20T12:00:00Z',
      state: 'open',
      body: 'A large pull request fixture.',
      user: { login: 'octo' },
      base: { sha: base, ref: 'main' },
      head: { sha: head, ref: 'large' },
      commits: 1,
      changed_files: shape.files,
    };
  if (rest.startsWith('pulls/7/files?')) {
    const page = Number(new URLSearchParams(rest.split('?')[1]).get('page') ?? 1);
    const files = [];
    for (let n = (page - 1) * 100; n < Math.min(page * 100, shape.files); n++)
      files.push(
        n === 0
          ? addedFile(shape.addedLines)
          : n === 1
            ? modifiedFile(shape.modifiedRows)
            : smallFile(n),
      );
    return files;
  }
  if (rest.startsWith('compare/'))
    return { status: 'ahead', merge_base_commit: { sha: base }, files: [] };
  if (rest.startsWith('pulls/7/comments?'))
    return [
      {
        id: 7001,
        user: { login: 'alice' },
        created_at: '2026-11-21T00:00:00Z',
        body: largePr.thread.body,
        path: largePr.modifiedPath,
        line: largePr.thread.line,
        side: 'RIGHT',
      },
    ];
  if (rest.startsWith('issues/7/comments?') || rest.startsWith('pulls/7/reviews?')) return [];
  return undefined;
}
