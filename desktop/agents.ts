import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AgentId, AgentInfo, Preferences } from '../shared/assistant.js';
import type { AssistantStore } from './assistant-store.js';

const exec = promisify(execFile);
function environment(path: string) {
  return {
    ...process.env,
    PATH: [dirname(path), process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin']
      .filter(Boolean)
      .join(delimiter),
  };
}
export async function discover(store: Pick<AssistantStore, 'executable'>) {
  const home = homedir(),
    nvm = join(home, '.nvm', 'versions', 'node');
  const versions = await readdir(nvm).catch(() => []);
  const directories = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...versions
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => join(nvm, v, 'bin')),
  ].filter(Boolean);
  const installed = await Promise.all(
    (['codex', 'claude'] as const).map(async (id): Promise<AgentInfo | null> => {
      const configured = store.executable(id);
      const candidates = configured
        ? [configured]
        : directories.map((dir) => join(dir, process.platform === 'win32' ? id + '.exe' : id));
      for (const path of new Set(candidates)) {
        try {
          await access(path, constants.X_OK);
        } catch {
          continue;
        }
        try {
          const opts = { env: environment(path), timeout: 5000, maxBuffer: 4 * 1024 * 1024 };
          const { stdout } = await exec(path, ['--version'], opts);
          let models = id === 'claude' ? ['sonnet', 'opus', 'haiku'] : [];
          if (id === 'codex') {
            try {
              const raw = await exec(path, ['debug', 'models', '--bundled'], opts);
              models = z
                .object({
                  models: z.array(
                    z.object({ slug: z.string(), visibility: z.string().optional() }),
                  ),
                })
                .parse(JSON.parse(raw.stdout))
                .models.filter((m) => !m.visibility || m.visibility === 'list')
                .map((m) => m.slug);
            } catch {
              /* Older clients accept an explicit model ID. */
            }
          }
          return { id, path, version: stdout.trim().slice(0, 120), models };
        } catch {
          continue;
        }
      }
      return null;
    }),
  );
  return installed.filter((a) => a !== null);
}
const agentEvent = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  is_error: z.boolean().optional(),
  model: z.string().optional(),
  message: z.object({ model: z.string().optional() }).optional(),
  item: z.object({ type: z.string(), text: z.string().optional() }).optional(),
  event: z.object({ delta: z.object({ text: z.string().optional() }).optional() }).optional(),
});

export async function runAgent(
  agent: AgentInfo,
  settings: Preferences,
  instructions: string,
  input: string,
  signal: AbortSignal,
  progress: (text: string) => void,
) {
  signal.throwIfAborted();
  const workdir = await mkdtemp(join(tmpdir(), 'local-reviewer-agent-'));
  const last = join(workdir, 'answer.txt');
  const args =
    agent.id === 'codex'
      ? [
          'exec',
          '--json',
          '--ignore-user-config',
          '--ignore-rules',
          '--skip-git-repo-check',
          '--ephemeral',
          '--sandbox',
          'read-only',
          '-c',
          'approval_policy="never"',
          '-c',
          'web_search="disabled"',
          '-c',
          'developer_instructions=' + JSON.stringify(instructions),
          ...['shell_tool', 'unified_exec', 'multi_agent', 'apps', 'plugins'].flatMap((f) => [
            '--disable',
            f,
          ]),
          '--output-last-message',
          last,
          ...(settings.provider === 'default'
            ? []
            : ['--oss', '--local-provider', settings.provider]),
          ...(settings.model ? ['--model', settings.model] : []),
          '-',
        ]
      : [
          '--print',
          '--safe-mode',
          '--no-session-persistence',
          '--permission-mode',
          'dontAsk',
          '--strict-mcp-config',
          '--tools',
          '',
          '--verbose',
          '--output-format',
          'stream-json',
          '--include-partial-messages',
          '--system-prompt',
          instructions,
          ...(settings.model ? ['--model', settings.model] : []),
        ];
  try {
    signal.throwIfAborted();
    const result = await new Promise<{ answer: string; reportedModel: string | null }>(
      (resolve, reject) => {
        const child = spawn(agent.path, args, {
          cwd: workdir,
          env: environment(agent.path),
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let pending = '',
          answer = '',
          reportedModel: string | null = null,
          size = 0,
          stderr = '',
          partial = '',
          failure = '';
        function stop(reason: string) {
          failure = reason;
          if (!child.pid) return;
          try {
            if (process.platform === 'win32') child.kill('SIGKILL');
            else process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
        }
        const abort = () => stop('Review cancelled.');
        const timer = setTimeout(() => stop('Agent timed out. Try a smaller question.'), 180000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        function event(line: string) {
          if (!line.trim()) return;
          try {
            const e = agentEvent.safeParse(JSON.parse(line)).data;
            if (!e) return;
            reportedModel = e.message?.model ?? e.model ?? reportedModel;
            if (e.type === 'stream_event' && e.event?.delta?.text) {
              partial += e.event.delta.text;
              progress(partial.slice(-32000));
            }
            if (e.item?.type === 'agent_message' && e.item.text) {
              answer = e.item.text;
              progress(answer);
            }
            if (e.type === 'result') {
              if (e.is_error || e.subtype !== 'success')
                failure = (e.result || 'Agent returned an error.').slice(0, 350);
              else answer = e.result ?? answer;
            }
          } catch {
            /* Ignore non-event startup output. */
          }
        }
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          size += Buffer.byteLength(chunk);
          if (size > 4 * 1024 * 1024) {
            stop('Agent output exceeded the size limit.');
            return;
          }
          pending += chunk;
          let end;
          while ((end = pending.indexOf('\n')) >= 0) {
            event(pending.slice(0, end));
            pending = pending.slice(end + 1);
          }
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr = (stderr + chunk).slice(-2048);
        });
        child.stdin.on('error', () => {
          /* Process exit reports authentication and invalid model errors. */
        });
        child.stdin.end(input);
        child.on('error', () => {
          failure = 'Could not start ' + agent.id + '. Check its executable.';
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          event(pending);
          if (failure || code !== 0)
            reject(
              new Error(
                failure ||
                  (/model.*(not|invalid|unsupported)/i.test(stderr)
                    ? 'Model unavailable. Choose another model.'
                    : 'Agent failed. Check its sign-in and selected model in your terminal.'),
              ),
            );
          else resolve({ answer, reportedModel });
        });
      },
    );
    if (agent.id === 'codex')
      result.answer = (await readFile(last, 'utf8').catch(() => result.answer)).trim();
    if (!result.answer.trim()) throw new Error('The agent returned an empty answer.');
    return result;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
export type { AgentId };
