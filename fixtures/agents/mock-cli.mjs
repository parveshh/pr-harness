#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('Fixture CLI 1.0');
} else if (args.includes('models')) {
  console.log(JSON.stringify({ models: [{ slug: 'fixture-model', visibility: 'list' }] }));
} else {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  const { evidence, question, selected, lookups } = JSON.parse(stdin);
  const emit = (data) => console.log(JSON.stringify(data));
  async function respond(answer) {
    if (args.includes('exec')) {
      await writeFile(args[args.indexOf('--output-last-message') + 1], answer);
      emit({ type: 'item.completed', item: { type: 'agent_message', text: answer } });
    } else {
      emit({ type: 'system', model: 'fixture-model' });
      emit({ type: 'result', subtype: 'success', result: answer });
    }
  }
  if (args.includes('invalid-model')) {
    console.error('model not available');
    process.exitCode = 1;
  } else if (lookups?.length === 0) {
    const query = selected.path === 'src/reader.ts' ? 'Review workspace' : 'first change';
    await respond(JSON.stringify({ prLookup: [{ op: 'search_diff', query }, { op: 'files' }] }));
  } else if (question === 'Wait for cancellation') {
    emit({ type: 'stream_event', event: { delta: { text: 'Waiting for cancellation' } } });
    await new Promise((resolve) => setTimeout(resolve, 60000));
  } else {
    if (question === 'Answer after the push' && process.env.LOCAL_REVIEWER_FIXTURE_RELEASE) {
      emit({ type: 'stream_event', event: { delta: { text: 'Holding the original revision' } } });
      while (!existsSync(process.env.LOCAL_REVIEWER_FIXTURE_RELEASE))
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const selectedLines =
      selected.addedFile?.lines.map((row) => ({ ...row, path: selected.path, side: 'new' })) ??
      evidence;
    const first = selectedLines.find(
      (e) =>
        e.path === selected.path &&
        (!selected.line || (e.line === selected.line.line && e.side === selected.line.side)),
    );
    const other = lookups
      ? lookups[0].result.rows[0]
      : evidence.find((e) => e.path !== selected.path);
    const answer = [
      '### Review notes',
      ...(lookups ? ['Read from the local PR copy.', ''] : []),
      '- **Selected change** [[' + first.id + ']]',
      '- Related caller [[' + other.id + ']]',
      '',
      '```ts',
      'const literal = "[[' + first.id + ']]";',
      '```',
      '',
      '| Check | Result |',
      '| --- | --- |',
      '| Scope | Local |',
      '',
      '[Documentation](https://example.com/docs) ![diagram](https://example.com/image.png)',
    ].join('\n');
    await respond(answer);
  }
}
