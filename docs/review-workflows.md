# Review workflows

Open a saved pull request to read its changes, compare it with another open PR, or investigate a failed check. For installation, GitHub sign-in, and agent setup, see the [README](../README.md#run-locally).

## Read a change and follow its evidence

Use **Overview** for the PR description, **Changes** to navigate the diff, and **Discussion** for published conversations. Filter the file tree by path, select a file, and move between hunks. Switch to **Full file** when you need the surrounding implementation. In a narrow window, the **Files**, **Diff**, and **Chat** controls switch panes.

Select a line or range to ask a question in **Review chat**. **Focused** context uses the selected evidence. Choose **Full PR** when a question depends on another file, such as a caller or test. Follow a filename and line in the answer to inspect its evidence. When several citations sit together, open **sources** and choose the one you want. **Back to changes** returns from a cited source file.

## Review a local branch before it is a pull request

1. Choose **Review local branch** on the Workspace page and pick the top-level folder of a local clone where a coding agent has been working. Check the repository and current branch, pick a base branch, and choose **Start review**.
2. Read the changes as you would a pull request. The diff runs from the merge base with the base branch to the working tree, so committed, staged, unstaged and untracked files all appear. **Uncommitted changes** in the header marks work that is not committed yet.
3. Draft comments and ask questions in **Review chat**. When the agent changes the clone, **Open update** loads the new revision and **Since my last review** shows what changed.
4. Open **Finish review** and choose **Preview brief**. **Copy for agent** or **Save as file…** hands the comments back to the agent as Markdown, with each file, line, excerpt and comment. Then choose **Save review checkpoint** so the next update compares against what you reviewed.

The app only reads the clone. It has no GitHub discussions, checks, approvals or lessons for a local review.

## Remember a lesson from a resolved discussion

Suppose a reviewer discovers that an export must use the account’s timezone. Once the inline discussion is resolved, choose **Remember review lesson** and enter a reminder such as “Check midnight in the account’s timezone.”

| When the reminder should appear | What to enter in **Code fragment** |
| --- | --- |
| Another PR in this repository changes the same file | Leave it empty. A reported rename from the saved path also matches. |
| A displayed change adds or removes particular code in any file in the repository | Enter a literal fragment such as `exportDateRange(`. Matching is case-sensitive and preserves spaces in the fragment. |

Choose **Save lesson**. On a later PR, the reminder appears beside the matching file, hunk, or full-file page. **Source discussion** opens the originating GitHub thread so you can see why the lesson was saved. Use **Edit review lesson** on the resolved source thread to revise it, or **Forget lesson** in the repository’s lesson list under **Overview**. Lessons persist in local SQLite and work with cached changes offline.

## Compare two open pull requests

1. Expand the repository sidebar and choose **Compare pull requests** beside a monitored repository. Pick the first PR, then a second open PR targeting the same base branch. Both are selectable regardless of which authors you watch.
2. Choose **Compare revisions**. The report identifies each head and merge base. Expand a shared path to inspect sampled changes from both sides.
3. Choose **Investigate with selected agent** to look for interactions across files. For example, one PR might rename an emitted field while another starts reading the old name. The report pairs each inferred consequence with an excerpt from each PR. Select a filename and line to inspect that revision on GitHub. Removed lines open at the merge base.
4. Read **Evidence limits** alongside the findings. An empty result means the agent found no interaction in the evidence it inspected. If a PR changes, use **Compare latest revisions** to rebuild the report. **Refresh PR list** updates which open PRs and base branches are available for selection.

The comparison stays in the open dialog. Investigating sends bounded excerpts to the selected agent, which can request up to four additional source ranges. A hosted model may receive those excerpts. Comparing PRs preserves your active review and drafts.

## Investigate a failed GitHub Actions job

1. Open **Checks** on the PR you are reviewing. Expand the failed job and choose **Investigate failure**. Check the commit, run number, attempt, and job ID shown above the diagnostics.
2. Choose **Inspect code** on an annotation with a source location. For an assertion on an added or modified line, the app shows the matching hunk and highlights the annotated lines in the excerpt. For an unchanged caller, it opens an excerpt from the reviewed commit. The runner’s message stays beside the code.
3. Use **Back to pipeline** to inspect another job. After a re-run, **Previous attempt** and **Next attempt** switch between jobs for that run. Close the dialog to return to your original review position.

| What you see | How to continue |
| --- | --- |
| A setup step failed and there are no annotations | Use **Open original job on GitHub** for the runner logs. |
| GitHub cannot return the annotations | Choose **Retry annotations** or open the original job. |
| The check belongs to another revision, or a path cannot be read at the reviewed commit | Inspect the original job and compare its commit with the one under review. |
| A diagnostic has no source location | Read its message in the report. The original job provides the surrounding output. |

Investigation reads GitHub metadata, annotations, and pinned source. It can be used without a coding agent.
