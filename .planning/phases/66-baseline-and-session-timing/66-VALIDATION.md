---
phase: 66
slug: baseline-and-session-timing
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-09-29
---

# Phase 66 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: `66-RESEARCH.md` → `## Validation Architecture`. Task IDs below follow the research's suggested plan split (66-01..66-08); the planner finalizes the exact task numbering.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Plain Node test scripts (`node tests/<file>.test.js`, custom assert/check helpers), plus `node:test` for some suites (e.g. `node --test tests/mcp-lattice-journal.test.js`). New bench suites use `.test.mjs`. |
| **Config file** | none. The root `package.json` `test` script is a ~298-command `&&` chain; `pretest` runs `mcp-session-recorder-journal`, `mcp-lattice-journal` and `mcp-session-export-port`. |
| **Quick run command** | `node tests/<touched-file>.test.js` (or `node --test …` / `node tests/<file>.test.mjs`) for each suite the task touches |
| **Full suite command** | `npm test` with loopback port 7225 free (`lsof -nP -iTCP:7225 -sTCP:LISTEN` empty) |
| **CI** | Node 20: `npm run validate:extension && npm test` (`.github/workflows/ci.yml`) |
| **Estimated runtime** | quick: < 30 s per suite; full chain: several minutes |

---

## Sampling Rate

- **After every task commit:** run the touched suites' quick commands. Whenever `extension/ai/agent-loop.js`, `extension/background.js` or `extension/ws/mcp-tool-dispatcher.js` changes, also run the pin suites:
  - `node tests/mcp-philosophy-parity-smoke.test.js`
  - `node tests/lattice-survivability-smoke.test.js`
  - `node tests/agent-loop-iterator-guard.test.js`
  - `node tests/cost-tracker-ordering.test.js`
  - `node tests/meta-cognitive-tracker.test.js`
  - `node tests/ownership-leakage-regression.test.js`
  - `node tests/run-task-cleanup-paths.test.js`
  - `node tests/lattice-step-emitter-smoke.test.js`
  - `node tests/lattice-provider-bridge-smoke.test.js`
- **After every plan wave:** `npm run test:mcp-journal && npm test` with 7225 free. A red `EADDRINUSE` means the chain stopped early, so the later suites never ran; do not count it as a pass.
- **Before `/gsd-verify-work`:**
  - The full `npm test` is green on the final commit, and `npm run validate:extension` is green.
  - The six `tests/bench-*.test.mjs` suites pass once under Node 20, using the official nodejs.org tarball, not `npx node@20`.
- **Max feedback latency:** 60 seconds for per-task checks.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 66-01-* | 01 | 0 | MEAS-03 (D-20, D-21) | T-66-02 | Raw exports stay in gitignored `scripts/bench/.local/`; committed history metrics carry no page content | unit + manual | `git check-ignore scripts/bench/.local/x` exits 0; export step is human (H1) | ❌ W0 | ⬜ pending |
| 66-02-* | 02 | 1 | MEAS-01 (D-04) | T-66-05 | Timing rides on `Symbol.for('fsb.mcp.call-timing')`, is never serialized into `_sendResult`, and string payload keys are never read as timing | unit (vm) | `node tests/mcp-bridge-background-dispatch.test.js` | ✅ extend | ⬜ pending |
| 66-02-* | 02 | 1 | MEAS-01 (D-04) | — | Recorder forwards `timing {v:1, receivedAt, completedAt, fsbMs}`; `beginCall` identity deep-equal unchanged | unit | `node tests/mcp-session-recorder-journal.test.js` | ✅ extend | ⬜ pending |
| 66-02-* | 02 | 1 | MEAS-01 (D-04, D-09) | — | Journal stores `metadata.timing` only when supplied; replay projection unchanged; both text exports show per-call ms and stay byte-equal | unit | `node --test tests/mcp-lattice-journal.test.js` | ✅ extend | ⬜ pending |
| 66-02-* | 02 | 1 | MEAS-01 / D-18 | T-66-01 | `_handleGetConfig` returns only an allowlist (`providerKind`, `modelProvider`, `modelName`, manifest version, extension id, `measurement` marker) and no secret-like keys | unit (vm) | `node tests/mcp-bridge-background-dispatch.test.js` | ✅ extend | ⬜ pending |
| 66-03-* | 03 | 1 | MEAS-02 (D-07, D-08) | T-66-03 | Journal session resolves in JSON (existing envelope, sanitized `actionHistory` with timing, no inline request/result strings) and text; branch skipped when the journal module is absent; `session_not_found` unchanged | unit (vm, real journal + memory backend) | `node tests/mcp-in-flight-session-lookup.test.js` | ✅ extend | ⬜ pending |
| 66-03-* | 03 | 1 | MEAS-01 | T-66-03 | `measurement` projection survives the `/token/i` secret filter; `durationMs` omitted when unmeasured | unit (vm) | `node tests/mcp-in-flight-session-lookup.test.js` | ✅ extend | ⬜ pending |
| 66-03-* | 03 | 1 | MEAS-02 | — | An id from `list_sessions` resolves via `get_session_detail` (round trip) | integration (vm) | `node tests/mcp-in-flight-session-lookup.test.js` or new `tests/mcp-session-detail-journal.test.js` | ❌ optional | ⬜ pending |
| 66-04-* | 04 | 1 | MEAS-01 (D-10, D-11) | — | `cost_in_usd_ticks` → USD; reasoning billed at output rate; exact `grok-4.3` rows; unknown model → `unavailable`, never Grok-priced | unit | `node tests/cost-tracker.test.js` | ✅ update | ⬜ pending |
| 66-04-* | 04 | 1 | MEAS-01 (D-05) | — | Iteration timing rows and `durationMs` survive `saveSession` in both branches; unmeasured values null/omitted, never 0 | unit | `node tests/automation-logger-mcp-retention.test.js` (new case) or new `tests/autopilot-measurement.test.js`; `node tests/action-history.test.js` | ✅ extend / ❌ new | ⬜ pending |
| 66-04-* | 04 | 1 | MEAS-01 (D-02) | — | `agent-loop.js` edits keep INV-04 (setTimeout iterator) and every pinned anchor | source pins | pin-suite list under Sampling Rate | ✅ run | ⬜ pending |
| 66-05-* | 05 | 1 | MEAS-03 (D-16) | — | Median/quantile known answers; bootstrap deterministic by seed; A/A → inconclusive; known 0.7× effect → CI excludes 1; zero-success task listed | unit | `node tests/bench-stats.test.mjs` | ❌ W0 | ⬜ pending |
| 66-05-* | 05 | 1 | MEAS-03 (D-17) | T-66-04 | Outcome evaluator uses fixture request log / final URL / DOM markers only; agent claims ignored | unit | `node tests/bench-outcome.test.mjs` | ❌ W0 | ⬜ pending |
| 66-05-* | 05 | 1 | MEAS-03 (D-15) | T-66-06 | Task JSON validated before use; fixture hashing stable; 6 mixed + 6 click-heavy core composition | unit | `node tests/bench-tasks.test.mjs` | ❌ W0 | ⬜ pending |
| 66-05-* | 05 | 1 | MEAS-03 (D-18) | T-66-01 | Canonical identity JSON + `tools/list` digest stable under key reordering; runner refuses Web Store id / missing marker / wrong model | unit | `node tests/bench-identity.test.mjs` | ❌ W0 | ⬜ pending |
| 66-05-* | 05 | 1 | MEAS-03 (D-12, D-14) | — | Claude stream summarizer extracts init/result, detects ToolSearch, labels cost as list-price estimate; argv parity with `claude-profile.ts` | unit | `node tests/bench-claude-stream.test.mjs` | ❌ W0 | ⬜ pending |
| 66-05-* | 05 | 1 | MEAS-03 (D-13) | T-66-04, T-66-06 | Fixture server binds 127.0.0.1 port 0, blocks path traversal, attributes requests per run token, evidence endpoint requires the runner secret | unit (local http) | `node tests/bench-fixture-server.test.mjs` | ❌ W0 | ⬜ pending |
| 66-06-* | 06 | 2 | MEAS-03 | T-66-01 | Runner preflight refuses: 7225 not owned by the runner's server, missing `measurement` marker, Web Store extension id, `providerKind !== 'api'`, wrong provider/model | unit + manual | covered by `node tests/bench-identity.test.mjs`; live `node scripts/bench/run-bench.mjs --preflight` | ❌ W0 / live | ⬜ pending |
| 66-07-* | 07 | 2 | MEAS-01..03 | — | Whole chain green; no timing in any tool response; Node 20 bench run | integration | `npm test` (7225 free); Node 20 run of `tests/bench-*.test.mjs` | ✅ run | ⬜ pending |
| 66-08-* | 08 | 3 | MEAS-03 | T-66-02 | Baseline results committed as sanitized metrics + identity only | live / manual | `node scripts/bench/run-bench.mjs --smoke` / `--campaign`; `node scripts/bench/report.mjs <campaignId>` | ❌ live-only | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

Threat refs (from `66-RESEARCH.md` → Security Domain; planners restate them in each plan's `<threat_model>`):
- **T-66-01:** API key or bridge secret leaking through `fsb://config` or benchmark identity.
- **T-66-02:** Page content from real sites committed in baseline files.
- **T-66-03:** Raw journal payloads returned over MCP.
- **T-66-04:** An agent tampering with or reading outcome evidence.
- **T-66-05:** Timing spoofed through payload keys.
- **T-66-06:** Malformed task JSON, or a fixture path-traversal read.

---

## Wave 0 Requirements

- [ ] Six new test files:
  - `tests/bench-stats.test.mjs`
  - `tests/bench-outcome.test.mjs`
  - `tests/bench-tasks.test.mjs`
  - `tests/bench-identity.test.mjs`
  - `tests/bench-claude-stream.test.mjs`
  - `tests/bench-fixture-server.test.mjs`

  Append all six to the root `test` chain and to `REFINEMENT_ROOT_TEST_COMMANDS` in `tests/delegation-phase-contract.test.js`, in one commit. Never edit that file's historical hashes.
- [ ] A synthetic Claude stream-json fixture with a realistic `result` event. The existing `tests/fixtures/agent-streams/claude-code-2.1.177` has no duration or cost fields.
- [ ] An xAI chat-completions response fixture with `usage.cost_in_usd_ticks`, `completion_tokens_details.reasoning_tokens` and `prompt_tokens_details.cached_tokens`.
- [ ] Environment, before the first extension edit:
  - `npm install`
  - `npm --prefix mcp ci`
  - `npm --prefix mcp run build`
  - `npm --prefix showcase/server install`

  Then confirm `npm test` is green on the start commit (port 7225 free).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Export the 40 recorded MCP sessions (2026-09-16..21) before they are pruned | MEAS-03 (D-20) | They exist only in the Web Store build's IndexedDB in Chrome Profile 2 | H1: run the console snippet from `66-RESEARCH.md` in the Web Store control panel's DevTools; save to `scripts/bench/.local/`; then run `node scripts/bench/export-history.mjs` to derive sanitized metrics |
| Set up the bench Chrome profile with the worktree's unpacked extension | MEAS-03 | Loading an unpacked extension and pairing can't be automated | H2: follow the `66-RESEARCH.md` checklist: dedicated `--user-data-dir`, Load unpacked, native-host manifest copy, `fsb-mcp-server pair --reset`, xAI key, `grok-4.3` |
| Reload the extension after the last extension commit | MEAS-01..03 | Chrome won't reload unpacked extensions programmatically | H3: reload in `chrome://extensions`, then run `node scripts/bench/run-bench.mjs --preflight`; it checks the marker, extension id and model |
| Smoke run, then the ~240-run baseline campaign | MEAS-03 | Needs a live browser, real LLM spend, and Claude usage windows | H4: `--smoke` (2-3 tasks × 2 runs × 2 arms); review evidence and identity; then `--campaign`; then `node scripts/bench/report.mjs <campaignId>` |
| Restore the everyday setup | — | Pairing is global and sticky | H5: close the bench Chrome, run `fsb-mcp-server pair --reset`, re-enable FSB in the everyday profile |
| Per-call timing visible to an operator in a live session | MEAS-01 | End-to-end check against the real extension | Run one MCP session in the bench profile, then call `get_session_detail` (JSON and `format:'text'`) and confirm per-call ms and labelled unavailable values |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
