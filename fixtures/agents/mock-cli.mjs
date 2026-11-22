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
  const { task, evidence, question, selected, lookups } = JSON.parse(stdin);
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
  } else if (task === 'compare-pull-requests') {
    const producer = evidence.left.find((row) => row.text.includes('customerId: account.id'));
    const consumer = evidence.right.find((row) => row.text.includes('event.accountId'));
    await respond(
      JSON.stringify({
        findings:
          producer && consumer
            ? [
                {
                  left: producer.id,
                  right: consumer.id,
                  consequence: 'The consumer reads a field the producer no longer emits.',
                },
              ]
            : [],
        gaps: [],
      }),
    );
  } else if (lookups?.length === 0) {
    const query = selected.path === 'src/reader.ts' ? 'Review workspace' : 'first change';
    const prLookup = [{ op: 'search_diff', query }, { op: 'files' }];
    if (question === 'Compare with the caller')
      prLookup.push(
        { op: 'read_source', path: 'callers.txt', start: 500 },
        { op: 'read_source', path: 'partial.ts', side: 'before', start: 850 },
      );
    await respond(JSON.stringify({ prLookup }));
  } else if (question === 'Wait for cancellation') {
    emit({ type: 'stream_event', event: { delta: { text: 'Waiting for cancellation' } } });
    await new Promise((resolve) => setTimeout(resolve, 60000));
  } else {
    if (question === 'Answer after the push' && process.env.LOCAL_REVIEWER_FIXTURE_RELEASE) {
      emit({ type: 'stream_event', event: { delta: { text: 'Holding the original revision' } } });
      while (!existsSync(process.env.LOCAL_REVIEWER_FIXTURE_RELEASE))
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Held until the test has left the PR, so the answer arrives while it is not on screen.
    if (question === 'Answer while away' && process.env.LOCAL_REVIEWER_FIXTURE_RELEASE) {
      emit({ type: 'stream_event', event: { delta: { text: 'Still working' } } });
      while (!existsSync(process.env.LOCAL_REVIEWER_FIXTURE_RELEASE + '-away'))
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
      'The reader saves its place as you move through the diff. Reopening the pull request restores the selected file and hunk, so you can continue reviewing where you left off. [[' +
        first.id +
        ']][[' +
        other.id +
        ']]',
      '',
      'When a new revision arrives, check the lines that changed before submitting your comments. The saved position and the comment anchor serve different purposes. [[' +
        first.id +
        ']]',
      '',
      ...(lookups ? ['Read from the local PR copy.', ''] : []),
      ...(question === 'Compare with the caller' && lookups?.[3]
        ? [
            'Caller [[' + lookups[2].result.lines[0].id + ']]',
            '',
            'Compare both versions [[' +
              lookups[2].result.lines[0].id +
              ']][[' +
              lookups[3].result.lines[0].id +
              ']]',
            '',
          ]
        : []),
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
