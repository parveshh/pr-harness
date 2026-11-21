# Local Reviewer

An Electron desktop workspace for reading GitHub pull requests file by file. SQLite keeps your diffs, reviewed files, and reading position between sessions.

## Run locally

Use the Node version in `.nvmrc`, then run `npm ci` and `npm run dev`. This launches Electron with live renderer updates. For a production build, run `npm run build` followed by `npm start`. The first launch may download the Electron binary.

Install GitHub CLI and sign in with `gh auth login` to fetch PRs. Save a GitHub PR URL and click the saved entry. Choose a file, move between hunks, and mark files reviewed as you go. Closing the app restores the active PR on the next launch. Returning to **Workspace** leaves the file checkpoints saved for the next time you open that PR.

The reader shows cached diffs while refreshing from GitHub. Unchanged files keep their progress. GitHub's file-list limit is 3,000 files. The reader labels incomplete lists and patches and distinguishes binary files from text changes when GitHub supplies that information.

Use **Full file** above the diff to read surrounding code with additions and deletions highlighted. **Diff only** returns to your saved hunk. The full-file view reads the pinned Git revisions on demand and pages long files.

Drag a divider, or focus it and use the arrow keys, to resize the sidebar, changed files, diff, chat, or re-review queue. The app remembers the pane widths. The file list and diff scroll independently. Scrollbars appear while a pane is moving and fade at rest. In a narrow window, switch between **Files**, **Diff**, and **Chat** above the work area.

Choose the palette at the bottom-left of the sidebar, or from the palette button in the header when the sidebar is collapsed. Petrol is the default. Midnight, Smoked Bronze, Titanium, and Graphite are also available. The workspace remembers your choice.

## Review with a local agent

In **Review chat**, choose an installed Codex CLI or Claude Code and a model. Leave the model blank to use the agent default. In **Review instructions & settings**, edit the built-in prompt and save it for the app, repository, or PR. A PR setting takes precedence over its repository and app defaults. **Use inherited settings** removes the current override. If discovery misses an installation, use **Choose executable**.

Select a diff line and choose **Explain file**, or type a question. **Related file** lets you include another changed file in the evidence. Chat renders GitHub-flavored Markdown, including lists, code blocks, and tables. Click a citation to jump to the original or updated line. Citations from earlier revisions open the saved excerpt. For a newly added file, **Explain file** describes its purpose and implementation. Each agent request includes the PR title, a bounded description and changed-file list, selected and related code evidence, and up to five recent exchanges from the same revision. New-file source is sent in line order and marked complete or partial. The CLI receives this context through stdin. The cached PR snapshot and conversation stay in local SQLite. An agent using a hosted model sends the selected evidence and recent conversation to its provider. Codex also supports a locally running Ollama or LM Studio provider.

Use the **Context** menu before sending a question. **Focused** uses the evidence described above. **Full PR** also lets the agent page through all cached patches, search for a symbol, and read definitions, callers, and tests anywhere in the repository. For example, ask “Which callers rely on the old return value, and do the tests cover the new one?” The agent can compare the reviewed head with its merge base. Diff citations jump to the reader. Source citations open the exact file and line at that commit on GitHub.

Full PR source reads require Git. The first source lookup for each revision downloads a shallow snapshot into the app’s per-user `pr-source` directory. Later reads reuse the local copy, including offline. Cached diffs are available even when the source download fails. The agent can request up to four batches of four lookups per question. The selected model receives the excerpts returned by those lookups, which can include unchanged repository code. Source reads support regular text files up to 2 MiB.

## Draft and submit a review

Click the comment icon beside a diff line to write directly beneath it. To comment on a block, drag the comment icon to another line on the same side of the hunk and release to open the inline editor. You can also click the first line number, Shift-click the last, and choose **Comment on lines**. You can select in either direction. Saved drafts appear under the last line, with **Edit** and **Discard** beside them. **Save draft** stores the text, side, line, excerpt, and revision locally. Reopen an annotated line to edit its draft. **Draft from answer** starts an editable comment at a cited line.

Open **Review drafts** to read, edit, or discard comments together. Add a summary and select **Comment**, **Approve**, or **Request changes**. **Save and close** keeps the review for later. **Preview submission** shows the exact comments, GitHub CLI account, and target commit. **Submit review to GitHub** sends one grouped review. If the revision has changed, refresh the PR and reattach older comments to a selected line before submitting.

If GitHub receives a submission but its response is lost, **Check GitHub** locates the receipt using a hidden tracking ID in the review body. Drafts remain saved while the outcome is unknown. **Open published review** opens the receipt in your browser.

Published line comments and their replies appear beneath the matching old or new diff line. Expand **PR conversation** beneath the description for review summaries, general questions, and threads without a current line anchor. Choose **Reply** and then **Post reply to GitHub** to send from the displayed account. Line replies stay in their original thread. Replies to a conversation comment or review summary link back to it in the PR timeline. **Refresh discussions** retrieves the latest messages. Full PR chat can also look up these discussions when a question refers to earlier feedback.

## Monitor repositories

In the sidebar, click **+** beside **Repositories**, enter a GitHub URL or `owner/repository`, and choose **Add repository**. Select authors from the contributor and recent PR lists, or enter a GitHub username. The sidebar lists their open PRs and refreshes about every two minutes while the app is open. Open a PR directly from the sidebar. The last successful list stays available offline.

## Project layout

- `client/` contains the React renderer. It accesses the desktop through `window.reviewer`.
- `desktop/` contains the Electron main process, sandboxed preload, and SQLite store. The database is `workspace.sqlite` in Electron's per-user application data directory.
- `shared/` contains the typed bridge and review validation. The main process validates data before writing it.

## Checks

Run `npm run lint`, `npm run format:check`, `npm run typecheck`, and `npm test`. Use `npm run format` to apply formatting. After building, `npm run test:desktop` verifies repository dialogs, monitored authors, both agent adapters, citation navigation, cancellation, the file reader, draft editing and discarding, an offline restart, and receipt recovery after a simulated lost submission response with a temporary profile and fixture CLI on macOS or Linux. Use `npm run test:desktop -- --live` to exercise a public PR with your signed-in GitHub CLI. Both desktop tests require a graphical session.

## Review another push

The open PR checks GitHub on focus, on refresh, and about once a minute while active. **Open update** switches to the newest prepared revision. Until then you can keep reading the current diff. Prepared updates, comparisons, and reading progress are saved locally.

**Since my last review** compares the latest revision with the first revision you opened or your most recent review checkpoint. A confirmed GitHub review or **Save review checkpoint** advances that checkpoint. The queue includes newly changed files, files that left the PR diff, and previously unread files. A changed file you already reviewed is labelled **Needs another look**. Use **Full PR** to read or comment on its current lines.

For a fast-forward push the comparison shows the patch between the two heads where GitHub supplies it. A rewritten history or base change shows changed hunks from the saved full PR diffs. The reader labels incomplete coverage. Old chat citations open their saved evidence. Draft comments follow a verified location. An uncertain draft keeps its original excerpt and blocks submission until you reattach it, move it to the summary, or discard it.

## Pin a question to a hunk

Choose **Pin question** beside the hunk navigation, write your question, and save it. Open questions appear beside their hunks and in **Since my last review**. **Pinned questions** in the header opens the list for the PR, including questions whose files have left the diff.

After you open an update, select a question to compare the original evidence with the current hunk. You can expand the full hunks or jump to the code. If a match is uncertain, the question retains its original evidence and identifies the uncertainty. Choose **Mark addressed** when satisfied. Addressed questions stay in the local list and can be reopened.

## Workspace settings and reply alerts

The gear at the bottom of the left rail opens **Settings**. Choose a theme, interface font, and text size. Code keeps its monospaced font and follows the selected text size. Appearance is saved in SQLite.

**Connect account** starts GitHub CLI browser sign-in for github.com. Complete the authorization on GitHub. Settings displays the active CLI account, and **Switch account** starts another sign-in.

The bell opens **Review replies**. Local Reviewer checks saved PRs and open PRs from monitored authors while the app is running, then catches up on reopen. A new threaded reply from someone else produces an in-app alert and unread badge. Open a reply to go to its GitHub discussion, or mark the inbox read. Each GitHub account has its own read state.
