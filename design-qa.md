# Local Reviewer desktop design QA

The comparison used the selected ImageGen mockup at 1731 × 909 and the Electron reader at the same CSS viewport. The fixture uses a different PR, a saved panel layout, a three-line selection, and an existing conversation. The captured desktop frame was scaled from 2× for comparison. A second capture at 850 × 720 checks the single-pane chat view.

| Area | Result |
| --- | --- |
| Layout | The navigation rail, changed-file tree, center diff, and chat form four vertical regions. The file tree and chat share the same top edge and height. The split button stays in the PR header. Custom panel widths and macOS window-control clearance account for the different proportions. |
| Typography | The initial comparison showed undersized diff text and pane titles. The revised view uses 15 px code and 16 px prose at standard text size. The PR title has looser tracking, comments have more line spacing, and chat paragraphs stop at a 64ch reading measure. The settings-selected interface font and text scale apply. |
| Sources | Repeated file paths interrupted paragraphs in the supplied readability screenshot. The revised wide and narrow chat captures show compact source controls in running text. Single references show the filename and line, and grouped references open a picker. Expanding Sources exposes each referenced path and line. Code literals remain literal. |
| Colour and icons | The comparison uses the Ink palette and green accent. Diff additions and deletions carry explicit signs. The existing icon library provides the rail, folder, file, and line-action icons. |
| Interactions | The fixture exercised panel collapse and keyboard focus, filtering and expanding folders, selected-line and range questions, inline draft editing, approval preview, and offline recovery. The narrow reader switches between Files, Diff, and Chat. |

The visual and interaction checks used an isolated Electron fixture on macOS. Other platforms and a live GitHub submission were outside this run.

Final result: passed
