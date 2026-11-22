import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, delimiter, basename } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { agentId, type AgentId, type AgentInfo, type Preferences } from '../shared/assistant.js';
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
const executableNames: Record<AgentId, string[]> = {
  codex: ['codex'],
  claude: ['claude'],
  cursor: ['cursor-agent', 'agent'],
  antigravity: ['agy'],
  copilot: ['copilot'],
};
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
    agentId.options.map(async (id): Promise<AgentInfo | null> => {
      const configured = store.executable(id);
      const candidates = configured
        ? [configured]
        : directories.flatMap((dir) =>
            executableNames[id].map((name) =>
              join(dir, process.platform === 'win32' ? name + '.exe' : name),
            ),
          );
      for (const path of new Set(candidates)) {
        try {
          await access(path, constants.X_OK);
        } catch {
          continue;
        }
        try {
          const opts = { env: environment(path), timeout: 5000, maxBuffer: 4 * 1024 * 1024 };
          const { stdout } = await exec(path, ['--version'], opts);
          // Other programs also install an executable named 'agent'.
          if (id === 'cursor' && !configured && /^agent(?:\.exe)?$/i.test(basename(path))) {
            const help = await exec(path, ['--help'], opts);
            if (!/cursor/i.test(help.stdout) || !help.stdout.includes('--approve-mcps')) continue;
          }
          let models = id === 'claude' ? ['sonnet', 'opus', 'haiku'] : [];
          try {
            if (id === 'codex') {
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
            } else if (id === 'cursor' || id === 'antigravity') {
              const flag = id === 'cursor' ? '--list-models' : 'models';
              const listing = await exec(path, [flag], opts);
              const slugs = new Set<string>();
              for (const row of stripVTControlCharacters(listing.stdout).split(/\r?\n/)) {
                const slug = /^([a-z0-9][a-z0-9./_-]{0,179})(?:$|\s+-\s+|\s{2,}|\t)/.exec(
                  row.trim(),
                )?.[1];
                if (slug) slugs.add(slug);
              }
              models = [...slugs];
            }
          } catch {
            /* Model listings may need sign-in. A configured model ID still works. */
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

const antigravityEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('init'), init: z.object({ model: z.string().optional() }) }),
  z.object({
    event: z.literal('step_update'),
    step_update: z.object({
      step_type: z.string(),
      text_delta: z.string().optional(),
    }),
  }),
  z.object({
    event: z.literal('result'),
    result: z.object({ status: z.string(), response: z.string().optional() }),
  }),
]);

// The print-mode CLIs can expand @file references before model tool permissions apply.
// JSON escapes preserve literal mentions in both review instructions and evidence.
function reviewPrompt(instructions: string, input: string) {
  const review: unknown = JSON.parse(input);
  return JSON.stringify({ instructions, review }).replaceAll('@', '\\u0040');
}

async function invocation(
  id: AgentId,
  settings: Preferences,
  instructions: string,
  input: string,
  workdir: string,
): Promise<{ args: string[]; stdin: string }> {
  const model = settings.model ? ['--model', settings.model] : [];
  switch (id) {
    case 'codex':
      return {
        stdin: input,
        args: [
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
          join(workdir, 'answer.txt'),
          ...(settings.provider === 'default'
            ? []
            : ['--oss', '--local-provider', settings.provider]),
          ...model,
          '-',
        ],
      };
    case 'claude':
      return {
        stdin: input,
        args: [
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
          ...model,
        ],
      };
    case 'cursor': {
      const config = join(workdir, '.cursor');
      await mkdir(config);
      await writeFile(
        join(config, 'cli.json'),
        JSON.stringify({
          permissions: {
            allow: [],
            deny: [
              'Shell(*)',
              'Read(**)',
              'Read(/**)',
              'Write(**)',
              'Write(/**)',
              'WebFetch(*)',
              'Mcp(*:*)',
            ],
          },
        }),
      );
      return {
        stdin: reviewPrompt(instructions, input),
        args: ['--print', '--trust', '--mode', 'ask', '--output-format', 'stream-json', ...model],
      };
    }
    case 'antigravity': {
      const agents = join(workdir, '.agents', 'agents');
      await mkdir(agents, { recursive: true });
      // Use an explicit allowlist for this standalone session. send_message has no peer.
      await writeFile(
        join(agents, 'local-reviewer.md'),
        [
          '---',
          'name: local-reviewer',
          'description: Review supplied pull request evidence.',
          'mainAgent: true',
          'subagent: false',
          'tools: [send_message]',
          'inheritMcp: false',
          'inheritCustomizations: false',
          'commandExecutionPolicy: "off"',
          '---',
          instructions,
        ].join('\n'),
      );
      return {
        stdin: JSON.stringify({ event: 'user', message: { content: input } }) + '\n',
        args: [
          '--agent',
          'local-reviewer',
          '--disable-slash-commands',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          ...model,
        ],
      };
    }
    case 'copilot': {
      const config = join(workdir, '.github', 'copilot');
      await mkdir(config, { recursive: true });
      await writeFile(join(config, 'settings.json'), JSON.stringify({ disableAllHooks: true }));
      // Provide a nonempty tool allowlist, then deny its only operation.
      return {
        stdin: reviewPrompt(instructions, input),
        args: [
          '--available-tools=view',
          '--deny-tool=read',
          '--disable-builtin-mcps',
          '--no-custom-instructions',
          '--trust-folder',
          '--silent',
          '--stream',
          'off',
          ...model,
        ],
      };
    }
  }
}

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
  try {
    const { args, stdin } = await invocation(agent.id, settings, instructions, input, workdir);
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
            const data: unknown = JSON.parse(line);
            if (agent.id === 'antigravity') {
              const message = antigravityEvent.safeParse(data).data;
              if (message?.event === 'init') {
                reportedModel = message.init.model ?? null;
              } else if (message?.event === 'result') {
                if (message.result.status !== 'SUCCESS')
                  failure = 'Antigravity could not complete the review.';
                else answer = message.result.response ?? '';
              } else if (
                message?.step_update.step_type === 'agent_response' &&
                message.step_update.text_delta
              ) {
                partial += message.step_update.text_delta;
                progress(partial.slice(-32000));
              }
              return;
            }
            const e = agentEvent.safeParse(data).data;
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
          if (agent.id === 'copilot') {
            answer += chunk;
            progress(answer.slice(-32000));
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
        child.stdin.end(stdin);
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
      result.answer = (
        await readFile(join(workdir, 'answer.txt'), 'utf8').catch(() => result.answer)
      ).trim();
    if (!result.answer.trim()) throw new Error('The agent returned an empty answer.');
    return result;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
export type { AgentId };
