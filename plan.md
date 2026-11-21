# Local Reviewer

Local Reviewer is a single-user workspace for reviewing GitHub pull requests with an installed coding agent and a model of the reviewer's choice. The reviewer should be able to answer three questions at any point: What changed? What evidence supports my concern? What needs another look since I last read this PR?

The first release should cover a complete review across **two pushes**. A polished summary of the first push proves little about whether someone can finish the review after the author responds.

## Implementation status · 21 November 2026

| Milestone | Working in the app | Evidence and remaining validation |
| --- | --- | --- |
| 1. Read and resume | Open saved GitHub PRs, browse files and hunks, mark files reviewed, restore reading position. Toggle between diff hunks and a full file with marked changes. | SQLite and Electron fixtures exercise reopen and offline reading. The full-file view uses the pinned merge base and head for modified files. |
| 2. Explain and discuss | Choose Codex CLI or Claude Code and a model, edit scoped prompts, render Markdown chat, follow citations, and draft from an answer. Full PR context can look up callers, tests, and published discussions. | Both CLI adapters are exercised with fixtures. Before release, record a real run with each supported CLI and verify the cited lines. |
| 3. Comment and publish | Draft inline or across a line range, preview and submit a grouped review, and reconcile an uncertain receipt. Read and reply to existing GitHub questions directly beside their lines. PR conversation holds general feedback and older threads. | Fixture submissions cover both sides of a diff, conversation replies, and lost receipts. Verify the release build on a dedicated test PR with explicit write authorization. |
| 4. Review a second push | Detect updates, compare against a checkpoint, retain reviewed-file progress, flag old evidence, and reattach or flag drafts. Pinned questions retain their original hunk and can be marked addressed. | The desktop fixture exercises fast-forward, force-push, base changes, and an answer arriving after a push. Run the two-push reviewer trial below. |

The workspace also supports repository and author monitoring, GitHub CLI account connection, in-app reply alerts, appearance settings, and resizable panes. [User guide](./README.md)

### What is left

1. **Validate the two-push workflow with reviewers.** Record whether they find a partially addressed concern, return to the right hunk, and publish the intended comment. Include a fork PR, an outdated thread, and a cold source download in the release checks.
2. **Measure large PRs.** Time first diff, full-file loading and scrolling, and cross-file answers. The current full-file reader pages long text. Git source reads have a 2 MiB limit per file. GitHub can return an incomplete file inventory or patch.
3. **Try guided reading order and PR description checks.** These are proposed experiments. Pinning a question across pushes is already implemented.
4. **Evaluate automatic explanations and batch re-analysis.** Today reviewers request an explanation or ask a chat question. Use trial feedback and model latency before choosing a default.
5. **Prepare desktop distribution.** Local development and build scripts exist. Packaging, signing, and release testing on each intended delivery platform remain open.

## One review from start to finish

1. **Open a PR.** Paste its GitHub URL. Show the author’s description, the current revision, existing review comments, and the changed files. Open the diff immediately and generate explanations as the reviewer reads.
2. **Choose an agent and model.** Detect supported executables on the machine, allow a custom executable path, and show the current choice beside chat. Remember a default and allow a per-review override. Label whether the agent uses an on-device or hosted model when known. The agent handles its own authentication.
3. **Read file by file.** Put the file list on the left, a line-selectable diff in the centre, and explanation or chat on the right. Each explanation identifies the before-and-after behaviour, the hunks responsible, and a question worth checking if one exists. Selecting a claim jumps to its evidence. Provide next-unread navigation, manual “mark reviewed,” and resume at the last hunk.
4. **Ask about the code.** Select lines and ask “Can this retry charge twice?” Chat starts with the selection, can bring in the caller and tests from the same revision, and shows which files it used. An answer can become an editable draft comment with one click. Reviewers can also write directly on a line.
5. **Publish a review.** Preview the exact comments, summary, target revision, and GitHub identity together. The reviewer chooses Comment, Approve, or Request changes. Save drafts locally until submission and link to the resulting GitHub review. GitHub supports grouping inline comments and a review decision in one request. [GitHub review API](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)
6. **Return after a push.** Offer “Since my last review” alongside “Full PR.” Keep the current reading position until the reviewer opens the update. Show changed files, carried-forward progress, and outstanding questions with new evidence.

## What re-review should feel like

Suppose a reviewer reads eight files and asks whether a retry can charge a customer twice. The author pushes a guard in the handler and adds a test. On return, the reviewer should land on the guard, see the original question beside it, and jump to the test. If the test covers sequential retries and the question was about simultaneous requests, the reviewer can keep it open. Only the reviewer marks the concern addressed.

| Event | Expected behaviour |
| --- | --- |
| Several commits arrive during review | Coalesce updates into the newest available revision. Compare it with the reviewer's checkpoint, even if the app has already fetched intervening pushes. |
| Four files were read, three were untouched | Preserve the three reviewed marks. Reopen the changed file at its first changed hunk and keep previously unread files in the queue. |
| A caller stays identical but its callee changes | Keep the caller’s read history. Flag explanations or questions that cited the changed callee for another look. |
| A comment moves or its line disappears | Reattach drafts only when side, surrounding text, and path or rename evidence identify one valid location. Otherwise show the original excerpt and let the reviewer re-anchor it or move it to the summary. |
| The author force-pushes or retargets the PR | Rebuild the current PR diff. Compare stored snapshots where available, label rewritten history, and carry forward only verified matches. |

Store the base, merge base, and head commit IDs for each snapshot. The full PR view compares the merge base with the head, following GitHub’s three-dot semantics. The return view compares the last reviewed head with the current head **and** checks for changes in the full PR diff caused by a new base. Persist per-file checkpoints so a partial review survives either change. Keep citations in old chats linked to their original snapshots. [GitHub branch comparisons](https://docs.github.com/en/pull-requests/reference/branches#comparing-branches-in-pull-requests)

## Architecture and design rationale

| Area | First choice | Reason |
| --- | --- | --- |
| Interface | Electron with React, TypeScript, and Vite | A desktop window hosts the diff and chat. Ship a sandboxed renderer with an isolated preload bridge. |
| Local service | Node.js in Electron's main process | Own SQLite, GitHub, Git, and agent subprocesses here. Expose named operations through IPC, validate the sending window and input, and stream future agent events by run ID. |
| GitHub | GitHub CLI for authenticated API calls | Reuse the reviewer's signed-in identity. Fetch paginated file and comment metadata and send the final review through a dedicated publish action. [GitHub CLI API manual](https://cli.github.com/manual/gh_api) |
| Revision contents | Git with an app-owned bare repository cache | Pin the objects used for each review, including fork PR heads. Read blobs and diffs without checking out the PR over the user's working tree. GitHub’s file-list endpoint caps results at 3,000 files, so use Git to complete the inventory or visibly mark missing coverage. [GitHub pull request files](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files) |
| Persistence | SQLite plus the Git object cache on disk | Store review progress, prompts, chats, drafts and publish receipts transactionally. Git owns source history. Cached diffs and drafts remain usable offline. |
| Agents | Separate Codex CLI and Claude Code adapters | Both are installed in the planning workspace and expose noninteractive output and model selection. Validate each integration with a real review before shipping. Local execution uses the provider configured in that CLI, which may send selected code to a hosted model. |

**Agent integration.** Start with one working adapter, then prove portability with the second before calling the picker complete. Each adapter discovers its executable and version, reports model choices when supported, starts a review with the selected model and instructions, streams events, and cancels a run. Where model discovery is unavailable, offer the agent default and a manually entered model ID. Surface rejected choices and let the reviewer select again. Record agent, requested model, reported model when available, and prompt version with each answer. Switching agents starts a fresh run with the selected local conversation context.

**Review instructions.** Offer an editable default system prompt with a local per-repository override. Preview the effective instructions and save a version with each run. Source files, PR descriptions, and comments enter as quoted review material. Give the agent read-only evidence from the pinned revision. The app owns GitHub writes. Start with this editable default:

> Explain the behaviour before and after the change. Cite the file and lines for each material claim. For a possible defect, describe the triggering conditions and the effect on the caller. If the answer depends on missing evidence, name what you would inspect. Treat the author's stated intent as a claim to check. Keep routine changes brief.

**Consistency.** Build each snapshot against pinned commits and check that the PR stayed on that revision while fetching mutable metadata. Key generated explanations by their input files, prompt version, agent and model. Store each draft with its original excerpt, file, side, line range and revision. Before publishing, refresh the head and validate the anchors against the current GitHub diff. If a submission times out, reconcile against the reviewer's GitHub reviews before retrying. [GitHub inline comment anchors](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request)

**Push detection.** For v1, check the open PR on focus, on manual refresh, and periodically while active using authenticated conditional requests and rate-limit backoff. Catch up on reopen. On a change, prepare the new comparison automatically. Generate updated explanations as the reviewer opens them, with an option to analyse all changed files. If closed-app notifications become important, revisit a GitHub App webhook receiver and its hosting requirements. [GitHub API guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#avoid-polling)

### Desktop framework decision

Use Electron for the first release. Its Node main process can own the database and launch installed agents, and React can render diffs in an isolated window. The distribution cost is a bundled Chromium and Node runtime. [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)

Tauri becomes attractive if download size takes priority and the team wants a Rust backend. It uses the operating system's webview. Keeping Node as an embedded sidecar adds a binary to package for each target. [Tauri architecture](https://v2.tauri.app/concept/architecture/) · [Sidecar distribution](https://v2.tauri.app/develop/sidecar/)

GPUI is a candidate if the diff viewer becomes a native editor with custom GPU rendering. Its UI is written in Rust. Before considering that investment, measure scrolling and selection on representative large PRs in the React viewer with off-screen rows virtualised. [GPUI](https://gpui.rs/)

## Features worth trying with reviewers

- **Pin a question across pushes.** Attach a question to a hunk and the evidence behind it. A later push can bring back that question with the relevant before-and-after lines. The implemented pinning flow is ready for the two-push usability trial.
- **Follow a behaviour across files.** Offer a reading order such as “request handler → retry policy → persistence → test.” Show why each file is next, with clickable references. Compare it with ordinary file-order navigation on the same PR.
- **Check the PR description against the diff.** Pair an author's claim such as “existing clients keep the same response” with the implementation and tests that bear on it. When evidence is missing, offer a question the reviewer can investigate.

## Delivery and validation

| Milestone | Demonstration that completes it |
| --- | --- |
| 1. Read and resume | Open a real PR, navigate additions, deletions and renames, recognise binary files, and reopen at the same file with progress intact. |
| 2. Explain and discuss | Using both installed agents, select a model, explain the same file, ask a cross-file question, follow its citations, and change the review prompt. Invalid model selection and cancellation preserve the review. |
| 3. Comment and publish | Draft on an addition and a deletion, restart the app, and submit one grouped review on a test PR. Simulate a timeout and verify the GitHub review appears once. |
| 4. Review a second push | Exercise a normal push, a force-push, and a base change. Verify the return queue, old chat citations and uncertain comment anchors. An older analysis completing late must stay attached to its original revision. |

For the first usability trial, give reviewers a two-push PR with a concern that is only partly addressed. Watch whether they find the missing case, how many unchanged files they reopen, and whether their final comment lands on the intended line. Use that result to decide whether to refine pinned questions, prototype guided reading order, or reduce agent response time.

**Next product decision.** When opening a large PR, should the reviewer land on the ordinary file list or a suggested reading order? Start with the familiar file list and test guided order as an explicit action. The same review checkpoints support both experiences.

## Continuing in a new session

Start with the implementation status and open work at the top of this plan. The [README](./README.md) explains how to run the desktop app, and [AGENTS.md](./AGENTS.md) defines the independent review loop. The reader lives in [Reader.tsx](./client/src/Reader.tsx), discussion placement and recovery in [PrDiscussions.tsx](./client/src/PrDiscussions.tsx), and pinned Git reads in [pr-source.ts](./desktop/pr-source.ts). The [desktop fixture](./scripts/desktop-smoke.mjs) exercises the workflow using an isolated Git repository, GitHub CLI, and agent adapters.
