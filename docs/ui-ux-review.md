# Board UI/UX review and styling update

Reviewed September 8, 2026 against the running desktop board and an isolated
preview with planning, epic, dependency, recovery, and completed-card states.

## Findings and changes

| Finding | Change |
| --- | --- |
| Project selection, queue operations, view filters, diagnostics, and settings compete in a single overflowing header. | Separate project/tools, board filters, and runtime status into distinct rows. Keep the project selector next to the wordmark and give card creation the primary button treatment. |
| View controls fall back to inconsistent browser button styling. | Apply consistent sizing, hover, disabled, focus, and selected states in light and dark themes. Expose toggle state and label icon-only controls for assistive technology. |
| Expanded epic rows can force a lane wider than every other column. | Give lanes an explicit width and zero minimum intrinsic width; wrap subtask titles and dependencies within the card. |
| Small labels and many competing colors make task titles harder to scan. | Increase title and summary readability, strengthen spacing, and use neutral label chips while retaining semantic priority, complexity, and warning colors. Keep full summaries available. |
| List view lacks a clear container and row hierarchy. | Group rows into full-width sections, preserve child indentation, and allow the list to scroll vertically without shrinking/clipping groups. |
| Cards require a pointer to open. | Make card surfaces keyboard-focusable; Enter/Space opens details, with existing drawer focus restoration. Nested controls retain their own behavior. |
| Phone drawer metadata squeezes summary copy into a narrow column. | Stack summary metadata, preserve full-width copy, and keep long drawer content scrollable with an accessible close control. |

## Verification

- Browser review of light/dark boards, expanded epics, list view, and card details.
- Responsive checks at 320, 390, 768, and 1280 pixels; visual previews at 1440 pixels.
- Filter results and keyboard opening/closing of the card drawer.
- Regression assertions for header bounds, list-row clipping, keyboard access,
  and lane width with long epic/dependency text.
- Existing hierarchy, drawer, hostile-data, recovery, and viewer checks.

The update changes presentation and navigation accessibility. Queue admission,
permissions, recovery rules, and the delivery migration remain separate. The
legacy stage names are retained; the planned delivery/cycle view still requires
its corresponding workflow implementation.

The broader optional voice suite currently times out in the existing Retry
Verification scenario (waiting for a fixture card to reach Done); its subsequent
push-to-talk cleanup assertions also time out. The same failure reproduces on
unchanged commit `ce1f2d8`, before this styling update. No voice workflow code is
changed here. The focused board/UI smoke suite passes all 15 tests.
