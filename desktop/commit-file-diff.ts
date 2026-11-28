// The filename in a PR snapshot is relative to its merge base. Resolve renames again
// between these two heads before restricting the patch to the selected file.
export async function commitFileDiff(
  before: string,
  head: string,
  path: string,
  git: (args: string[]) => Promise<string>,
) {
  const compare = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '-M'];
  const renamed = (
    await git([...compare, '--name-status', '-z', '--diff-filter=R', before, head, '--'])
  ).split('\0');
  let paths = [path];
  for (let at = 0; at + 2 < renamed.length; at += 3) {
    const old = renamed[at + 1],
      next = renamed[at + 2];
    if (old !== undefined && next !== undefined && (path === old || path === next)) {
      paths = [old, next];
      break;
    }
  }
  return (
    await git([
      ...compare,
      '--unified=3',
      before,
      head,
      '--',
      ...paths.map((name) => ':(literal)' + name),
    ])
  ).replace(/\n$/, '');
}
