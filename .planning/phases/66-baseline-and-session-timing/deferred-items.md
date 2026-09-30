# Phase 66 deferred items

Out-of-scope discoveries logged by plan executors. Nothing here was fixed in the plan that found it.

## From 66-07 (2026-09-30)

### FSB's content click activates the target twice

- **Where:** `extension/content/actions.js`.
  - The `click` tool (lines ~2436-2441) dispatches synthetic `mousedown`, `mouseup` and `click` events, then also calls `element.click()`, unconditionally.
  - `clickAtCoordinates` (lines ~148-155) does the same.
- **Effect, measured:** chrome-headless-shell 146 ran the same sequence from an isolated world, as a content script would. One FSB-style click:
  - left a toggle button, a native checkbox (clicked directly or through its `<label>`) and a `role="switch"` div unchanged;
  - submitted a form twice.

  A trusted CDP click activated each control once.
- **Who sees it:** both benchmark arms (autopilot and Claude Code over MCP), and any real site whose controls toggle on click or whose submit handler is not idempotent.
  - The `click` tool then reports no effect on toggles.
  - Auto-saving toggles send two requests.
- **Why deferred:** 66-07 is bench-only and does not edit `extension/**`.
  - The benchmark fixtures neutralize the repeat in `scripts/bench/fixtures/_shared/bench.js`, so the frozen corpus measures speed rather than this defect.
  - A product fix belongs in its own change, with the paired tripwire tests updated.
