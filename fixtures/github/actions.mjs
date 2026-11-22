// Fixture responses for the read-only Actions and Checks endpoints used by the desktop test.
export function actionsFixture(endpoint, head, stage, newRevision) {
  if (!endpoint.includes('/actions/') && !endpoint.includes('/check-runs/')) return undefined;
  const run = newRevision ? 910 : 900;
  const attempt = newRevision || stage !== 'passed' ? 1 : 2;
  const running = !newRevision && stage === 'running';
  const baseUrl = 'https://github.com/example/project/actions/runs/' + run;
  if (endpoint.includes('/actions/runs?')) {
    const matchesHead = new URLSearchParams(endpoint.split('?')[1]).get('head_sha') === head;
    return {
      total_count: Number(matchesHead),
      workflow_runs: matchesHead
        ? [
            {
              id: run,
              name: 'Check scaffold',
              display_title: 'Preserve review progress',
              event: 'pull_request',
              status: running ? 'in_progress' : 'completed',
              conclusion: running ? null : attempt === 2 ? 'success' : 'failure',
              run_attempt: attempt,
              run_number: newRevision ? 8 : 7,
              workflow_id: 70,
              head_sha: head,
              run_started_at: '2025-01-01T00:00:00Z',
              html_url: baseUrl,
              created_at: '2025-01-01T00:00:00Z',
              updated_at: '2025-01-01T00:01:05Z',
            },
          ]
        : [],
    };
  }
  const requested = Number(/\/attempts\/(\d+)\/jobs/.exec(endpoint)?.[1]);
  if (requested && endpoint.includes('/actions/runs/' + run + '/')) {
    const done = !running,
      passed = requested === 2;
    const step = (number, name, conclusion) => ({
      number,
      name,
      status: conclusion ? 'completed' : 'in_progress',
      conclusion,
      started_at: '2025-01-01T00:00:00Z',
      completed_at: conclusion ? '2025-01-01T00:00:42Z' : null,
    });
    function job(offset, name, steps) {
      const id = run + offset + (requested - 1) * 5;
      return {
        id,
        run_id: run,
        run_attempt: requested,
        head_sha: head,
        name,
        steps,
        status: done ? 'completed' : 'in_progress',
        conclusion: done ? (passed ? 'success' : 'failure') : null,
        check_run_url: 'https://api.github.com/repos/example/project/check-runs/' + (id + 100),
        html_url: baseUrl + '/job/' + id,
        started_at: '2025-01-01T00:00:00Z',
        completed_at: done ? '2025-01-01T00:01:05Z' : null,
      };
    }
    return {
      jobs: [
        job(1, 'check', [
          step(1, 'Set up job', 'success'),
          step(2, 'Run npm test', done ? (passed ? 'success' : 'failure') : null),
        ]),
        ...(done && !passed
          ? [
              job(2, 'runner setup', [step(1, 'Set up job', 'failure')]),
              job(3, 'checks access', [step(1, 'Read checks', 'failure')]),
            ]
          : []),
      ],
    };
  }
  const checkId = Number(/\/check-runs\/(\d+)/.exec(endpoint)?.[1]);
  if (checkId) {
    if (!endpoint.includes('/annotations?')) return { id: checkId, head_sha: head };
    if (checkId === run + 103) throw Error('HTTP 403');
    if (checkId !== run + 101) return [];
    const annotation = (path, line, message) => ({
      path,
      start_line: line,
      end_line: line,
      title: 'Assertion failed',
      message,
      annotation_level: 'failure',
    });
    return [
      annotation(
        'src/reader.ts',
        40,
        newRevision ? 'Guard still permits the second retry.' : 'Expected retries to stop.',
      ),
      annotation('callers.txt', 500, 'Caller assertion differs.'),
    ];
  }
  throw Error('Unexpected CI fixture endpoint: ' + endpoint);
}
