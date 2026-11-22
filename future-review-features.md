# Cross-PR comparison and failed-check investigation

Both features are available in the desktop app. The original scope and acceptance fixtures are recorded below.

## 4. Compare two open pull requests

Implemented in the repository sidebar. [User guide](./docs/review-workflows.md#compare-two-open-pull-requests)

A reviewer selects two open PRs in the same monitored repository and asks what could go wrong if both land. Start with PRs targeting the same base branch. Pin both heads and their merge bases so every finding opens the code that produced it.

- Show overlapping changes first, then investigate related changes across different files. For example, one PR renames an emitted event field while the other introduces a consumer that reads the old name.
- Show the producer and consumer excerpts side by side, explain the concrete consequence, and link each excerpt to its own PR and revision. Distinguish observed changes from inferred interactions. Mention incomplete evidence and offer a fresh comparison after either head moves.
- For a first release, use the two existing saved diffs and read-only source lookup. Keep findings private. Support manual pair selection before considering automatic comparisons across a repository.

**Acceptance fixture.** Use two textually mergeable PRs that introduce an incompatible producer and consumer, plus an unrelated pair. The reviewer can follow both citations and see when a new push makes the comparison stale. The unrelated pair produces no claimed interaction.

## 5. Investigate a failed check from the diff

Implemented in the pipeline view. [User guide](./docs/review-workflows.md#investigate-a-failed-github-actions-job)

A reviewer chooses **Investigate failure** on a failed job in the existing pipeline view. Start with GitHub check annotations for the reviewed commit. Associate a diagnostic with the exact run attempt, job, source path and line before offering a jump into code.

- Show the runner's diagnostic beside the cited source line. If it overlaps a changed hunk, open the hunk. If it points to unchanged code, open the pinned source and label any suggested connection to the diff as an inference.
- Show setup failures and missing annotations with a link to the original job. Offer the failing log excerpt as a later extension for checks without structured annotations.
- Keep previous attempts identifiable when a job is re-run. Preserve the current review position so the reviewer can return after investigating.

**Acceptance fixture.** Cover an assertion on a changed line, a failure in unchanged code, a setup failure, unavailable annotations, and a re-run on a newer revision. Verify each source jump and that investigating a failure performs only reads.
