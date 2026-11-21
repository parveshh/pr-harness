import { spawn, type ChildProcess } from 'node:child_process';
import { githubEnvironment } from './github.js';
import type { SignIn } from '../shared/workspace.js';

export function githubLogin() {
  let child: ChildProcess | null = null,
    state: SignIn = { state: 'idle' };
  function cancel() {
    const running = child;
    child = null;
    state = { state: 'idle' };
    running?.kill();
  }
  return {
    cancel,
    progress: () => state,
    start(): SignIn {
      if (child) return state;
      const proc = spawn(
        'gh',
        ['auth', 'login', '--hostname', 'github.com', '--web', '--skip-ssh-key'],
        { env: githubEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60 * 1000 },
      );
      child = proc;
      state = { state: 'waiting', code: null };
      let tail = '';
      const inspect = (data: Buffer) => {
        if (child !== proc) return;
        tail = (tail + data.toString()).slice(-4096);
        const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(tail)?.[1];
        if (code) state = { state: 'waiting', code };
      };
      proc.stdout.on('data', inspect);
      proc.stderr.on('data', inspect);
      proc.on('error', () => {
        if (child === proc) {
          child = null;
          state = {
            state: 'error',
            message: 'Could not start GitHub CLI. Install gh and try again.',
          };
        }
      });
      proc.on('close', (code) => {
        if (child !== proc) return;
        child = null;
        state =
          code === 0
            ? { state: 'complete' }
            : {
                state: 'error',
                message: /GH_TOKEN|GITHUB_TOKEN/.test(tail)
                  ? 'GitHub CLI is using an environment token. Manage that account in your shell.'
                  : 'GitHub sign-in did not complete. Try connecting again.',
              };
        tail = '';
      });
      return state;
    },
  };
}
