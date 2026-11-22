# Local Reviewer

An Electron desktop workspace for reading GitHub pull requests file by file. SQLite keeps your diffs, reviewed files, and reading position between sessions.

For a walkthrough of the reader, repository lessons, cross-PR comparisons, and failed checks, see the [review workflow guide](docs/review-workflows.md).

## Download the desktop app

On a Mac with Apple silicon, open the arm64 disk image and drag **Local Reviewer** to **Applications**. On Windows x64, run the installer. Install Git and GitHub CLI and sign in with `gh auth login` to fetch pull requests. The macOS build uses an ad-hoc signature and has no Apple notarization. The Windows installer has no publisher signature. [GitHub releases](https://github.com/parveshh/pr-harness/releases)

## Run locally

Use the Node version in `.nvmrc`, then run `npm ci` and `npm run dev`. This launches Electron with live renderer updates. For a production build, run `npm run build` followed by `npm start`. The first launch may download the Electron binary.

Install GitHub CLI and sign in with `gh auth login` to fetch PRs. Save a GitHub PR URL and click the saved entry. Choose a file, move between hunks, and mark files reviewed as you go. A file with published line comments shows a comment icon and their count at the right of its row. Closing the app restores the active PR on the next launch. Returning to **Workspace** leaves the file checkpoints saved for the next time you open that PR.

The reader shows cached diffs while refreshing from GitHub. Unchanged files keep their progress. GitHub's file-list limit is 3,000 files. The reader labels incomplete lists and patches and distinguishes binary files from text changes when GitHub supplies that information.

Use **Full file** above the diff to read surrounding code with additions and deletions highlighted. **Diff only** returns to your saved hunk. The full-file view reads the pinned Git revisions on demand and pages long files.

Both views colour code by language, chosen from the file name. The old and new sides of a hunk are each read as continuous source, so a comment or string that spans lines keeps its colour. A hunk that starts inside one can be coloured wrongly until it ends, because the text above the hunk is not part of the diff. Files in an unrecognised language stay plain, as does a hunk or full-file page over 150,000 characters or with a line over 2,000.

Drag a divider, or focus it and use the arrow keys, to resize the sidebar, changed files, diff, chat, or re-review queue. The app remembers the pane widths. The file list and diff scroll independently. Scrollbars appear while a pane is moving and fade at rest. In a narrow window, switch between **Files**, **Diff**, and **Chat** above the work area.

New workspaces start with the Ink palette and green accent. Change appearance in **Settings** on the navigation rail. Existing workspaces keep their saved choices.

The changed-file tree groups files by folder. Filter by name or path. Collapse the tree or the full-height chat with its heading chevron. Use the files icon in the left rail to show or hide the tree. Reopen chat from the PR header. The rail highlights open panes.

## Review with a local agent

Choose the harness and model from the picker in the Review chat header. It supports Codex CLI, Claude Code, Cursor Agent (`cursor-agent` or `agent`), Antigravity CLI (`agy`), and GitHub Copilot CLI (`copilot`). Install and sign in to the CLI you want to use. Your choice applies to every PR and survives a restart. Leave the model blank to use the agent default. Codex can also use a local Ollama or LM Studio provider. If discovery misses an installation, use **Choose executable** in the same picker.

In **Review chat**, the sliders button in the heading opens **Review instructions**, where you choose separate prompts for **PR summary** and **Code review and questions**. Edit either prompt and save it for the app, repository, or PR. A PR prompt takes precedence over its repository and app defaults. **Use inherited instructions** removes the current override.

Choose **Summarise PR** for an overview of the whole pull request: its purpose, the main behaviour changes by area, the riskiest changes to read first, and gaps in the tests. It always uses Full PR context, described below, and the answer lists changed files the agent did not inspect.

Choose **Review PR** in chat or on the PR’s sidebar row to review the pinned revision. Each finding includes its priority and proposed comment. Open its line or range to inspect the code, then mark it **Valid** or **Dismissed**. **Add draft comments** copies validated, anchored findings into the local review. You can edit the drafts and submit them through **Finish review**. Decisions survive a restart. After opening a new revision, run the review again to draft against the updated lines.

Each PR has its own chat: its conversation, the question you are typing, and any answer in progress. An answer keeps running when you open another PR or return to **Workspace**, and its PR row in the sidebar shows a turning ring until it finishes. Reopen the PR to follow or cancel it. One answer runs per PR, and up to three PRs can have an answer running at once. While an answer runs, chat shows what was asked, how long it has taken, and the agent's latest text, and scrolls to keep it in view unless you have scrolled up.

Select a diff line and choose **Explain file**, or type a question. **Related file** lets you include another changed file in the evidence. Chat renders GitHub-flavored Markdown, including lists, code blocks, and tables. A citation such as **reader.ts:500** opens line 500. When several citations appear together, choose **sources** to pick a file and line. Expand **Sources** beneath an answer to see the full file paths and line numbers. Citations from earlier revisions open the saved excerpt. For a newly added file, **Explain file** describes its purpose and implementation. Each agent request includes the PR title, a bounded description and changed-file list, selected and related code evidence, and up to five recent exchanges from the same revision. New-file source is sent in line order and marked complete or partial. The CLI receives this context through stdin. The cached PR snapshot and conversation stay in local SQLite. An agent using a hosted model sends the selected evidence and recent conversation to its provider. Codex also supports a locally running Ollama or LM Studio provider.

Use the context menu under the question box before sending a question. **Focused** uses the evidence described above. **Full PR** also lets the agent page through all cached patches, search for a symbol, and read definitions, callers, and tests anywhere in the repository. For example, ask “Which callers rely on the old return value, and do the tests cover the new one?” The agent can compare the reviewed head with its merge base. Diff citations jump to the reader. Source citations open the cited line in the in-app editor at the commit used for the answer, including files outside the diff. Choose **Back to changes** to resume your review.

Full PR source reads require Git. The first source lookup for each revision downloads a shallow snapshot into the app’s per-user `pr-source` directory. Later reads reuse the local copy, including offline. Cached diffs are available even when the source download fails. The agent can request up to four batches of four lookups per question. The selected model receives the excerpts returned by those lookups, which can include unchanged repository code. Source reads support regular text files up to 2 MiB.

## Draft and submit a review

Click the comment icon beside a diff line to write directly beneath it. To comment on a block, drag the comment icon to another line on the same side of the hunk and release to open the inline editor. You can also click the first line number, Shift-click the last, and choose **Comment**. You can select in either direction. Saved drafts appear under the last line, with **Edit** and **Discard** beside them. **Save draft** stores the text, side, line, excerpt, and revision locally. Reopen an annotated line to edit its draft. **Ask assistant** opens chat with the selected line as context. Follow an answer citation to comment on its source.

Open **Finish review** to read, edit, or discard comments together. The split button’s **Approve PR** option opens the approval preview. Outdated comments return you to the drafts for reattachment. Add a summary and select **Comment**, **Approve**, or **Request changes**. **Save and close** keeps the review for later. **Preview submission** shows the exact comments, GitHub CLI account, and target commit. **Submit review to GitHub** sends one grouped review. If the revision has changed, refresh the PR and reattach older comments to a selected line before submitting.

If GitHub receives a submission but its response is lost, **Check GitHub** locates the receipt using a hidden tracking ID in the review body. Drafts remain saved while the outcome is unknown. **Open published review** opens the receipt in your browser.

Published line comments and their replies appear beneath the matching old or new diff line. Open **Discussion** for review summaries, general questions, and threads without a current line anchor. Choose **Reply** and then **Post reply to GitHub** to send from the displayed account. Line replies stay in their original thread. Replies to a conversation comment or review summary link back to it in the PR timeline. A line comment thread shows **Resolve conversation**, which marks it resolved on GitHub straight away, and a resolved thread shows **Reopen conversation**. Resolved threads stay in place, dimmed and labelled. The buttons appear only where your account is allowed to resolve the thread. **Refresh discussions** retrieves the latest messages. Full PR chat can also look up these discussions when a question refers to earlier feedback.

## Follow the pipeline

The **Checks** button beneath the PR title shows how GitHub Actions stands for the commit you are reviewing: running, queued, awaiting approval, failed, passed, or no runs. Only the newest run of each workflow counts towards that standing; an earlier run that was cancelled or re-triggered is shown dimmed as superseded. A fork PR whose workflows need a maintainer's approval shows as awaiting approval. Click it to see each workflow run, its jobs, and every step with its result and duration. Jobs that failed or are still running start expanded. **Open on GitHub** opens the run in your browser for logs and re-runs.

The view refreshes about every ten seconds while it is open and up to three runs are unfinished, and more slowly otherwise. It pauses while the window is hidden. **Refresh** reads it at once. It covers GitHub Actions for the reviewed commit, up to fifteen runs. After a push, open the update to follow the new commit's runs. Checks from other CI services are not listed.

## Monitor repositories

In the sidebar, click **+** beside **Repositories**, enter a GitHub URL or `owner/repository`, and choose **Add repository**. Choose **Select authors**, search by GitHub username, and check the authors to follow. You can also add a username missing from the list. Choose **Apply selection** to save them together. The sidebar lists their open PRs and refreshes about every two minutes while the app is open. Open a PR directly from the sidebar. The last successful list stays available offline.

When a watched author opens a pull request, the app shows a system notification, counts it on the app icon in the Dock or launcher, and highlights its row with a **New** tag. Clicking the notification opens the PR. Opening the PR clears the tag and lowers the count. PRs that are listed because you just added a repository or chose an author are not treated as new. New PRs are found when the list refreshes, about every two minutes while the app's window is open, so a notification can trail GitHub by a few minutes. A PR that is closed and reopened is announced again, and a draft is announced when it is created. On macOS the count on the Dock icon needs notifications to be allowed for the app. Windows shows the notification and the highlight but no count on the icon.

Each PR row in the sidebar has two icons. The sparkle opens the PR and starts **Summarise PR** in Review chat. The check opens the PR's review with **Approve** already chosen; nothing is sent until you preview and submit it. A PR whose latest review from your GitHub CLI account is an approval has a green background and a green check. That state is read from GitHub when the list refreshes and right after you submit a review, so an approval made on github.com shows too. GitHub keeps an approval after new commits unless it is dismissed, so a green row does not mean you have seen the latest push.

## Project layout

- `client/` contains the React renderer. It accesses the desktop through `window.reviewer`.
- `desktop/` contains the Electron main process, sandboxed preload, and SQLite store. The database is `workspace.sqlite` in Electron's per-user application data directory.
- `shared/` contains the typed bridge and review validation. The main process validates data before writing it. It also holds pure modules used by the renderer and tested with Node, such as the per-PR chat store (`chat-runs.ts`) and the syntax highlighter (`highlight.ts`).

## Checks

Run `npm run lint`, `npm run format:check`, `npm run typecheck`, and `npm test`. Use `npm run format` to apply formatting. After building, `npm run test:desktop` verifies repository dialogs, monitored authors, all five agent adapters, citation navigation, cancellation, the file reader, draft editing and discarding, an offline restart, and receipt recovery after a simulated lost submission response with a temporary profile and fixture CLI on macOS or Linux. Use `npm run test:desktop -- --live` to exercise a public PR with your signed-in GitHub CLI. Both desktop tests require a graphical session.

## Review another push

The open PR checks GitHub on focus, on refresh, and about once a minute while active. **Open update** switches to the newest prepared revision. Until then you can keep reading the current diff. Prepared updates, comparisons, and reading progress are saved locally.

**Since my last review** compares the latest revision with the first revision you opened or your most recent review checkpoint. A confirmed GitHub review or **Save review checkpoint** advances that checkpoint. The queue includes newly changed files, files that left the PR diff, and previously unread files. A changed file you already reviewed is labelled **Needs another look**. Use **Full PR** to read or comment on its current lines.

For a fast-forward push the comparison shows the patch between the two heads where GitHub supplies it. A rewritten history or base change shows changed hunks from the saved full PR diffs. The reader labels incomplete coverage. Old chat citations open their saved evidence. Draft comments follow a verified location. An uncertain draft keeps its original excerpt and blocks submission until you reattach it, move it to the summary, or discard it.

## Previously pinned questions

Questions saved in earlier versions are available under **Pinned questions** and beside their hunks in **Since my last review**.

After you open an update, select a question to compare the original evidence with the current hunk. You can expand the full hunks or jump to the code. If a match is uncertain, the question retains its original evidence and identifies the uncertainty. Choose **Mark addressed** when satisfied. Addressed questions stay in the local list and can be reopened.

## Workspace settings and reply alerts

The gear at the bottom of the left rail opens **Settings**. Choose a theme, including **Light**, an accent colour for buttons and highlights, an interface font, and a text size. Settings is the only place the theme changes. Code keeps its monospaced font and follows the selected text size. Appearance is saved in SQLite.

**Connect account** starts GitHub CLI browser sign-in for github.com. Complete the authorization on GitHub. Settings displays the active CLI account, and **Switch account** starts another sign-in.

The bell toggles the **Review replies** sidebar beside your workspace. Local Reviewer checks saved PRs and open PRs from monitored authors while the app is running, then catches up on reopen. A new threaded reply from someone else updates the unread badge on the bell. Open a reply to go to its GitHub discussion, or mark the inbox read. Each GitHub account has its own read state.

## Remember review lessons

On a resolved inline discussion, choose **Remember review lesson** and write a private reminder. Leave **Code fragment** empty to show it when another PR in the same repository changes that file, including a rename from its saved path. Enter a case-sensitive fragment to show it wherever a displayed change in that repository adds or removes the exact text.

Reminders appear beside the diff or full-file page and link to their original GitHub discussion. The **Overview** tab lists all lessons for the repository and lets you forget one. Lessons are saved on this device and available when reading cached changes offline. Opening the original discussion on GitHub requires a connection.

## Compare two pull requests

Expand the repository sidebar and choose **Compare pull requests** beside a monitored repository. Pick two open PRs targeting the same base branch, including PRs by authors you do not watch. **Compare revisions** pins each head and merge base and shows changed paths in common, including rename paths.

Choose **Investigate with selected agent** to check for interactions across files. Each finding pairs an inferred consequence with excerpts from both PRs. Click a filename and line to open the exact source revision on GitHub. Removed lines link to the merge base. Evidence limits appear in the report.

The comparison reuses current saved diffs and fetches missing revisions without changing your active review. While open, it checks for updates on focus, every minute, and on demand. **Compare latest revisions** starts a fresh comparison. Results are private to the open dialog. The selected agent receives bounded excerpts and may request four additional read-only source ranges.

## Investigate a failed check

Open **Checks**, expand a failed job and choose **Investigate failure**. The investigation identifies the workflow, run, attempt, job and reviewed commit. Choose **Inspect code** on a runner annotation to see its diagnostic and highlighted lines in a diff hunk or in source at that commit. Closing the dialog returns you to your review position.

Use **Previous attempt** and **Next attempt** to inspect earlier jobs after a re-run. Setup failures show their failed steps. When a job has no annotations, an annotation cannot be loaded, or its source is unavailable, **Open original job on GitHub** takes you to that job’s logs. Investigating uses read-only requests.
