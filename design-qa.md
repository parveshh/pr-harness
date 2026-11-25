# Repository queue and focused review

The selected mockup shows two states of the same window. The repository stays selected as the reviewer moves from its pull-request list into a diff. The mockup shows a filename picker. The current reader uses a persistent file explorer. The original comparison below records the earlier on-demand chat design. The current layout opens chat with the PR and gives each pane its own header at the top of the window.

## Visual comparison

| Evidence | Location |
| --- | --- |
| Selected ImageGen mockup | `~/.codex/generated_images/01a20dee-1fd3-7043-8060-9b1deb1f38b4/exec-c88a00a5-df59-4185-ae02-bfb984aaa71f.png` |
| Electron captures | `/private/tmp/local-reviewer-queue-qa/repository-queue.png` and `repository-review.png` in the same directory |
| Comparison, mockup on the left | `/private/tmp/local-reviewer-queue-qa/comparison.png` |

The reference is a 1536 × 1024 image containing two desktop window excerpts. Each comparison uses the 1506-pixel interior width. Both Electron captures use a 1506 × 720 CSS viewport at one output pixel per CSS pixel. The comparison crops the bottom of each capture to the corresponding reference height and scales both sides together. Electron’s content capture excludes native window buttons.

| Area | Findings and changes |
| --- | --- |
| Repository queue | The first capture showed a narrower sidebar and smaller headings than the mockup. The default sidebar now occupies 19% of the window, and the page and sidebar titles have distinct sizes. The selected repository uses an accent tint. PR numbers and titles lead each row. Author, draft state and actions follow. |
| Open PR | The pull-request breadcrumb, title, filename picker and code occupy one reading pane. The app retains review submission, checkpoints, file-view controls, discussion and checks. The fixture contains a real inline discussion, which accounts for the extra content below its first diff hunk. |
| Typography and icons | The reviewer’s font, text size, palette and accent apply to the new controls. The capture uses the light palette and the fixture’s saved humanist font. File paths truncate inside the picker button. The file list supports full-path search. The reference requires only standard interface icons, supplied by the app’s existing icon library. |
| Short windows | In the first desktop run, returning from chat at 850 × 440 left the diff with no visible height. The revised reader scrolls vertically when its controls and diff exceed the available height. The desktop fixture now exercises that transition. |

## Interaction coverage

The Electron fixture exercises repository selection, opening a PR, returning to the queue, keyboard filtering, resizing, and collapsing the file explorer, automatic chat on open and restore, closing and reopening chat, recovering typed questions, re-reviewing a push, and reopening saved work offline. The narrow checks include a 570-pixel workspace and an 850-pixel reader. The screenshots and interactions use an isolated profile and controlled GitHub and agent responses on macOS.

Final result: passed
