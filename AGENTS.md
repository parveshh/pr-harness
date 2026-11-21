# Working on Local Reviewer

Follow these conventions when developing the application. Read [plan.md](./plan.md) for the review workflow. The system prompt that users edit inside the app is a separate product feature.

## Code organisation and TypeScript

- Keep the React client responsible for interaction and presentation. The Node.js service owns SQLite, Git objects, GitHub calls, and agent processes. Share validated request, response, and stream event types across that boundary. Keep Node imports out of browser modules.
- Enable `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Give the client and service their own TypeScript environments so browser globals cannot accidentally enter service code. Type-check both, including their tests.
- Accept external data as `unknown` and validate it once at entry. This applies to HTTP payloads, agent output, and stored JSON. A type assertion cannot validate a payload. Use inferred types inside functions and explicit contracts at module boundaries where the shape matters to a caller.
- Model mutually exclusive states as discriminated unions. For example, a publish result can be `published`, `rejected`, or `outcome-unknown`. The last state needs reconciliation before retry. Use exhaustive handling where a new state would require a UI or persistence change.
- Name things for the review behaviour they represent, such as `reviewedHeadSha` and `latestHeadSha`. Keep diff comparison and anchor matching as pure functions. Introduce shared helpers when callers share behaviour, and keep changes focused on the requested feature.

## React

- Keep rendering pure. Derive the unread count from the file review records. Keep transient state such as the selected line close to its component, and give durable state such as a saved draft one authoritative owner. [React purity rules](https://react.dev/reference/rules/components-and-hooks-must-be-pure)
- Publish from the explicit submit handler. Use effects for external subscriptions such as a review event stream. Include reactive dependencies and clean up listeners, timers, and obsolete requests when the PR or run changes. Check event identity before applying a late result. [React Hooks lint rules](https://react.dev/reference/eslint-plugin-react-hooks)
- Use stable domain IDs for list keys so sorting files or receiving a push preserves focus and draft text. Use labelled native controls for diff navigation, commenting, and submission. Keep those actions reachable by keyboard and return focus to the originating hunk when the comment editor closes.
- Render PR text, diffs, and model output as untrusted content. Use text rendering by default and sanitise rendered Markdown if HTML is supported. Preserve the draft and show an actionable error when a save or publish fails.

## Node.js, SQLite, and agent integrations

- Keep Electron IPC handlers thin. Validate the sending frame and inputs, invoke the review operation, and return typed results. Expose named operations through a context-isolated preload bridge, keep the renderer sandboxed, and keep credentials in the main process or the CLI that owns them.
- Launch trusted, configured executables with asynchronous `spawn` or `execFile`, an argument array, and shell expansion disabled. Pass prompts through stdin where supported. Enforce output limits, handle startup and exit errors, and propagate cancellation to the child. [Node.js child processes](https://nodejs.org/api/child_process.html)
- Treat PR contents as evidence. Provide agents read-only access to the pinned revision and keep GitHub publishing behind the reviewer's submit action. Attach the run ID, revision, agent, selected model, and prompt version to generated results.
- Use parameterised SQL, versioned migrations, and short transactions for related writes. Keep network calls and model runs outside transactions. Preserve existing drafts during upgrades and reconcile an uncertain GitHub submission before attempting another write.
- Include operation and run identifiers in diagnostics. Keep tokens, raw prompts, private diffs, and draft bodies out of routine logs. Distinguish a user cancellation from an agent failure.

## ESLint and Prettier

When scaffolding the application, put these settings in version-controlled config. Pin the formatter version and commit the package-manager lockfile so editors and CI produce the same output.

| Tool | Repository convention |
| --- | --- |
| ESLint | Use flat config, `@eslint/js` recommended rules, and `typescript-eslint`'s `recommendedTypeChecked` for TS and TSX. Enable `parserOptions.projectService` for files covered by a TypeScript project. Scope browser, Node, and test globals to their respective files. [Typed linting](https://typescript-eslint.io/getting-started/typed-linting/) |
| Type-aware rules | Treat `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `no-explicit-any`, and the preset's unsafe-value rules as errors. Use the TypeScript extension of `no-unused-vars` in TS files and disable its core counterpart there. Handle failures in intentionally detached tasks. |
| React linting | Apply the recommended `eslint-plugin-react-hooks` preset to client components and hooks. Enforce `react-hooks/rules-of-hooks` and `react-hooks/exhaustive-deps` as errors. [React Hooks plugin](https://react.dev/reference/eslint-plugin-react-hooks) |
| Prettier | Use two spaces, single quotes in JS/TS, semicolons, trailing commas where supported, LF endings, and a preferred print width of 100. Run Prettier directly and apply `eslint-config-prettier` last to disable conflicting style rules. [Prettier integration](https://prettier.io/docs/integrating-with-linters) |

Limit a necessary lint suppression to the specific rule and line, and explain why the operation is correct. Exclude generated output, coverage, Git caches, local databases, and byte-exact diff fixtures from tools that would rewrite them. Keep unrelated formatting out of feature changes.

## Tests and completion checks

- Test through the entry point that owns the behaviour. Use small, real diffs for line mapping, temporary SQLite databases for migrations and draft recovery, and controlled adapters for GitHub and model output. Routine tests should run without credentials or paid model calls.
- For changes to re-review or publishing, cover the failure the change could introduce. Examples include an ambiguous anchor after a force-push, a late answer after switching PRs, and a timeout after GitHub accepted a review. Check the resulting saved state or visible outcome.
- At scaffold time, expose root package scripts named `lint` (ESLint with `--max-warnings 0`), `format` (Prettier write), `format:check` (Prettier check), `typecheck`, `test`, and `build`. Use the same read-only checks locally and in CI. Until the scaffold exists, these names are conventions for implementation.
- Before handing off code, inspect the diff, run the applicable checks, and report what passed and what remains unverified.

## Independent review loop before handoff or commit

1. Before handoff or commit, ask an agent who did not implement the change to review the implementation and tests against the requested behavior. The reviewer should trace affected callers and check migrations, failure paths, permissions, and test coverage where relevant.
2. Fix actionable findings, run the applicable checks, and return the revised changes to the independent reviewer. Repeat until the reviewer confirms that no actionable findings remain and the checks pass.
3. When committing, have the independent agent review the exact staged diff. If it changes, repeat the review before committing.
4. At handoff, report the independent review outcome, the checks that passed, and any remaining verification limits.

## Looking up technical documentation

For questions about libraries, frameworks, SDKs, APIs, CLIs, or cloud services, use Context7 outside the default sandbox, including for setup, migration, syntax, and library-specific debugging. Use the full question with sensitive information removed.

1. Run `npx ctx7@latest library "<official name>" "<question>"`, unless the user supplied an `/org/project` ID.
2. Choose the best match by name, relevance, source reputation, snippet coverage, and benchmark score. Use the returned version-specific ID when one matches the requested version.
3. Run `npx ctx7@latest docs <libraryId> "<question>"` and use the returned documentation. Limit the lookup to three commands per question. Retry sandbox-related network failures outside the sandbox. On quota exhaustion, report it and suggest `npx ctx7@latest login` or `CONTEXT7_API_KEY`.

Skip this lookup for ordinary refactoring, original scripts, business-logic debugging, code review, and general programming concepts.
