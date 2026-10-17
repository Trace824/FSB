P70_START=3f7efb0ac7aae5607b97f0e5c3b26f41733a3e8e

# Phase 70: Sync re-check at P70_START (D-24)

**Recorded:** 2026-10-17, plan 70-01 Task 1, before any Phase 70 source edit.
**Tree:** branch Jev at `3f7efb0a` ("docs(phase-68): update tracking after phase execution"). The Phase 68 code-review fixes (`2788ebfc` CR-01 through `38312ca1` IN-06) are in this tree, so every fact below is read after them.
**Upstream finished:** `66.1-08-SUMMARY.md`, `67-13-SUMMARY.md`, `68-11-SUMMARY.md` and `69-08-SUMMARY.md` exist. Phase 68's highest-numbered plan is 68-12 (`68-12-SUMMARY.md` also exists); 68-11 is its gate plan, so both are present. `git status --porcelain -- extension tests package.json scripts showcase mcp` printed nothing.
**Guard:** `tests/jev-run-task-upstream-contract.test.js` (registered in the root chain and `REFINEMENT_ROOT_TEST_COMMANDS`, plan 70-01 Task 2) asserts the names and behaviour below and fails loudly on drift.

Later Phase 70 plans read this file first. The "Drift substitutions" section (item t) is authoritative over any name or shape quoted in a Phase 70 plan.

## Interface re-check

| Interface | Quoted at | Real location (file:line) | Status |
| --- | --- | --- | --- |
| `fsbFastModeSessionField(storedValue, source)` and its return shapes | 68-06-PLAN.md:108, :118-119 | `extension/background.js:4011-4015`; spread `...(fastModeField ? { fastMode: fastModeField } : {}),` at :14226; computed at :14200 | MATCH (item a) |
| `fsbRecomputeFastModeForFollowUp(existingSession, source)` | 68-06-PLAN.md:118-121 | `extension/background.js:4150-4168` (flush, then one `getStorageWithTimeout` read, then assign or delete) | MATCH |
| 68-06 source checks in tests/jev-fast-start-path.test.js (settings-read key array, createSessionHooks SHA-256 literal) | 68-06-PLAN.md:112 | `tests/jev-fast-start-path.test.js:547-571` (read, fieldLine, spread, agent-return order); `:55` `CREATE_SESSION_HOOKS_SHA256`, asserted at `:606-608` | MATCH |
| `FsbFastPath.constants` values | 68-04-PLAN.md:77 | `extension/ai/jev-fast-path.js:40-60` (deep-frozen literal) | MATCH (item b; key set is pinned, see item b) |
| `FsbFastPath` export list | 68-04/68-05/68-08 | `extension/ai/jev-fast-path.js:2108-2130` (`var api = {...}`, not frozen), `root.FsbFastPath = api` :2131, `module.exports = api` :2132 | MATCH (item b) |
| `classifyStepEvidence(op, toolResult)` | 68-04-PLAN.md:82, :146 | `extension/ai/jev-fast-path.js:496-514` | CHANGED (item f: reason `dispatch_unconfirmed` also has outcome `uncertain`; Drift substitution 3) |
| `ensureMeasurement`, `appendAttempt`, `addCommandTotals` | 68-04-PLAN.md:87 | `jev-fast-path.js:830-837`, :840-848, :905-938 | MATCH |
| `attemptFromResult` attempt keys (quoted as including `calibrationStatus`, `jevCalled`, `toolMs`) | 68-04-PLAN.md:87 | `jev-fast-path.js:858-896`; keys are exactly `iteration, command, decisionSource, jevCalled, servedModel, instrumentVersion, calibrationStatus, latencyMs, usage, cost, fallback, outcome, escalationReason, op, stepOutcome` | CHANGED (no `toolMs`; item c; Drift substitution 4) |
| `describeEscalation(reason)` code set | 68-04 Task 2 step 2 | `jev-fast-path.js:552-641` (`ESCALATION_TEXT` table :552-608, `CHOICE_TEXT` :611-630, generic sentence :632) | MATCH (item d) |
| `session.fastMode {enabled, stored, source}` | 68-05-PLAN.md:72 | read at `jev-fast-path.js:1315` (`enabled`) and :1859 (`stored`) | MATCH |
| `session._fastPath` layout `{off, offReason, offCommand, inFlight, pendingSteps, stopReason, uncertain, recent, lastLlmTools, refEpoch, docEpoch}` | 68-05-PLAN.md:73 | `jev-fast-path.js:1011-1034` (`fastPathOf`) | CHANGED (item c; Drift substitution 5) |
| `session.agentState.jevFast` layout | 68-05-PLAN.md:74 | `jev-fast-path.js:1042-1073` (`commandStateOf`) | CHANGED (item c; Drift substitution 5) |
| `beforeTurn(session, {sessionId, iteration, deps?})` | 68-05-PLAN.md:78 | `jev-fast-path.js:1279-1299` (capture wrapper) | MATCH |
| beforeTurn steps a-v | 68-05-PLAN.md:119-140 | steps a-u live in the inner `attemptStep(session, ctx, capture)` at `jev-fast-path.js:1307-1509`; the step-v flush helper is `deliverPending(session, deps, reason)` at :1172-1208 | RENAMED (item b; Drift substitution 1) |
| `afterStep(session, step, toolResults)` | 68-05-PLAN.md:79 | `jev-fast-path.js:1604-1689` (synchronous, no await) | MATCH |
| `observeTools(session, toolCalls, toolResults)` | 68-05-PLAN.md:80 | `jev-fast-path.js:1736-1779` (synchronous, no await) | MATCH |
| `latchOff(session, reason)`, `abortInFlight(session)` | 68-05-PLAN.md:81 | `jev-fast-path.js:1091-1104`, :1076-1084 | MATCH |
| `flushHandoff(session, ctx?)` | 68-05-PLAN.md:82, 68-06-PLAN.md:121 | `jev-fast-path.js:1218-1228` (calls `deliverPending`) | MATCH |
| `createHarness({providerKey, loadFastPath, sessionPatch, contentResponder, providerScript, deps, jevClient, permissionDenies})` | 68-06-PLAN.md:160 | `tests/fixtures/agent-loop-fast-harness.js:211-223` (option list), returns :548-572 | CHANGED (superset; item h; Drift substitution 6) |
| `tests/fixtures/jev-fake-gateway.js` (`calibratedBody`, `uncalibratedBody`, `snapshotChangedBody`, `fallbackBody`, `makeClient`) | 68-04 (68-06-PLAN.md:160) | exports `TEST_ENDPOINT, SERVED_MODEL, INSTRUMENT_VERSION, CATCH_ALL, optionKeys, calibratedBody, uncalibratedBody, snapshotChangedBody, fallbackBody, makeHeldTimers, makeClient` | MATCH (superset) |
| 68-08 capture gate cases naming run_task | 68-08-PLAN.md:103-104 | item g | MATCH |
| 68-08 lazy `TOOL_REGISTRY` resolution in jev-fast-path.js | 68-08-PLAN.md:115 | `function toolRegistry()` at `jev-fast-path.js:1999-2010`, `toolDefinitionOf(name)` :2012-2019 | MATCH (item e) |
| 68-08 exporter goal rule (`deriveRecords`) | 68-08-PLAN.md:28, :144 | `scripts/bench/shadow/export-capture.mjs` `goalOf(task)` :146-150 (not exported), `START_PREFIX` :78, `deriveRecords` :198 (exported) | MATCH (item k) |
| `cloneJevMeasurementForPersistence` | 68-09-PLAN.md:20-31 | `extension/utils/automation-logger.js:319`; called at :1104 and :1112 | MATCH (item q, Task 2) |
| `projectJevMeasurement` | 68-09-PLAN.md:20-31 | `extension/ws/mcp-tool-dispatcher.js:2774`; called at :2367-2369 | MATCH (item q, Task 2) |
| tests/fixtures/jev-fast-disclosure-facts.js exports `SHARED_PHRASES, CARD_ONLY_PHRASES, PAGE_ONLY_PHRASES, FORBIDDEN_PATTERNS, ENFORCEMENT, textOf(html)` | 68-12-PLAN.md:24 | `tests/fixtures/jev-fast-disclosure-facts.js:128-135` (29 / 2 / 6 / 4 / 4 entries) | MATCH (item j) |
| Card markers `id="fsbJevFastModeCard"` .. `<!-- /fsbJevFastModeCard -->` | 68-12-PLAN.md:120 | `extension/ui/control_panel.html:636` and `:665` | MATCH (item j) |
| Privacy Control fact names the MCP settings tool | 68-10-PLAN.md:71 | `showcase/angular/src/app/pages/privacy/privacy-page.component.html:65` (`@@privacy.section.jevFastMode.control`) | MATCH (item j) |
| Card copy has no MCP or settings-tool sentence | 68-12-PLAN.md:125 | card text (item j) | MATCH |
| `FsbJevState.scrubText`, `matchesSecret`, `toOriginPath` | 67-06-PLAN.md:69-76 | `extension/ai/jev-state.js:277-284`, :287-289, :672-680 (path scrubbed per segment by `scrubPathSegment` :657-663) | MATCH (item l) |
| `FsbJevState.buildRequest(input, {byteBudget})` -> `{ok:true, request, idMap, stats}` or `{ok:false, reason:'invalid_request'|'sensitive_goal'}` | 67-06-PLAN.md:69-75 | `jev-state.js:763-939`; secret check on the untruncated goal :780 | MATCH (item l) |
| Goal over `CAPS.goalChars` (1000) gives `invalid_request` | 67-01-PLAN.md:90, :189 (quoted by 70-CONTEXT D-22 and 70-04) | `jev-state.js:125` `goalChars: 1000`; `buildRequest` truncates the goal at :851 (`truncateCodePoints(input.goal, CAPS.goalChars)`); only the validator `:373` refuses an over-cap goal, and `buildRequest` validates the truncated request | CHANGED (item l; Drift substitution 7) |
| `CONTRACT.FALLBACK_REASONS` (19), `NON_TRANSIENT_REASONS` (6) | 67-01-PLAN.md:82, :85 | `jev-state.js:43-67`, :91 | MATCH |
| `matchesSecret(s) === (scrubText(s) !== s)` | 67-01-PLAN.md:152 | `jev-state.js:287-289` | MATCH |
| tests/helpers/mcp-in-process.mjs (`createInProcessClient({runtimePath, bridge, agentScope})`, `makeStubBridge({onSend})` with `calls`, `makeMockAgentScope()`, `assertBuildFresh()`) | 69-01-PLAN.md:140-146, :198-203 | `tests/helpers/mcp-in-process.mjs:16` re-exports `scripts/mcp/lib/tools-list.mjs` (`makeMockAgentScope` :43, `makeStubBridge` :56, `createInProcessClient` :70); `assertBuildFresh` :51 | MATCH (item m) |
| `tests/mcp-tools-list-shape-freeze.test.js`, `tests/mcp-expect-caller.test.mjs` | 69-06-PLAN.md:12, 69-07-PLAN.md:10 | both exist (also `tests/mcp-expect-wire.test.js`) | MATCH (item m) |
| `mapFSBError` success passthrough `JSON.stringify(fsbResult, null, 2)` | mcp/src/errors.ts ~:452-454 | `mcp/src/errors.ts:473-475` (inside `if (fsbResult && fsbResult.success) {`) | MATCH (line moved; item m) |
| Bridge anchors (`_handleStartAutomation`, `response.sessionId`, guarded `activeSessions` read, `settle`, safety net, `handleComplete`/`handleError`, listeners, `_sendResult`) | interfaces block (e1e6439c lines) | item n (Task 2) | MATCH (lines moved) |
| background.js anchors (`createSessionHooks`, `handleStartAutomation`, `tabInfo`, `activeSessions.set`, `sessionHooks`/`runAgentLoop`, stop broadcast) | interfaces block | `createSessionHooks` :4735-4766; `handleStartAutomation` :13941; `tabInfo = await chrome.tabs.get(targetTabId);` :14077 and :14143; `activeSessions.set(sessionId, sessionData);` :14246; `sendResponse({ success: true, sessionId, ...` :14349-14356; `const sessionHooks = createSessionHooks(sessionId);` :14466 then `runAgentLoop(sessionId, {` :14467; stop broadcast :14729-14742 (`outcome: 'stopped'` :14738, `reason: 'user_stopped'` :14739, `stopped: true` :14740) | MATCH (lines moved; items o, p) |
| agent-loop.js emits (BEFORE_TOOL_EXECUTION with the denial lookup, AFTER_TOOL_EXECUTION, AFTER_ITERATION, meta-cognitive force stop) | interfaces block | BEFORE emit :2335-2340, denial lookup `(permResult.results || []).find(function(r) { return r && r.denied; })` :2342; AFTER emit :2915-2919; AFTER_ITERATION emit :3014-3019; force stop :2972-2991 | MATCH (lines moved; item p) |
| tests/run-task-resolve-discipline.test.js harness parts | :31-44, :150-262, :281-290, :295-316 | counters :31-41, `flushMicrotasks` :43-45, chrome mock with `runtime.onMessage._emit` :82-110, `FakeWebSocket` :112-130, virtual clock :134-204, task-store stub recording `writeSnapshotCalls` :210-227, `buildHarness` :206-281, `runTest` :285-294, bus settle :301-327 | MATCH (lines moved) |
| tests/ownership-leakage-regression.test.js `extractNamedFunction(source, name)` | :19-33 | `tests/ownership-leakage-regression.test.js:19-33` | MATCH |
| `scripts/bench/sweep-tests.mjs` usage and exit codes | `--files <paths> [--baseline <json>] [--out <json>]`; 1 failures, 2 usage | `scripts/bench/sweep-tests.mjs:31-46` (also `--per-test-timeout-ms`) | MATCH |

No row is MISSING, so the phase proceeds. None of the stop-condition interfaces (`fsbFastModeSessionField`, `FsbFastPath.beforeTurn`, `FsbFastPath.flushHandoff`, `FsbFastPath.classifyStepEvidence`, `FsbJevState.buildRequest`, `FsbJevState.scrubText`, `FsbJevState.matchesSecret`, the harness, the fake gateway, the in-process helper, the disclosure fixture) is missing.

## a. `fsbFastModeSessionField`

Exact source (`extension/background.js:4011-4015`):

```javascript
function fsbFastModeSessionField(storedValue, source) {
  if (storedValue !== true) return null;
  const from = typeof source === 'string' && source ? source : null;
  return { enabled: from !== 'mcp', stored: true, source: from };
}
```

Its doc comment (`background.js:4002-4010`) says "a run_task start (source 'mcp') carries enabled:false and never takes a fast step (D-03)"; no test pins that comment text.

Real return values (evaluated in a vm from the extracted text):

| Input | Result |
| --- | --- |
| `(true, undefined)` | `{"enabled":true,"stored":true,"source":null}` |
| `(true, 'dashboard')` | `{"enabled":true,"stored":true,"source":"dashboard"}` |
| `(true, 'mcp')` | `{"enabled":false,"stored":true,"source":"mcp"}` |
| `(false, 'mcp')` | `null` |
| `(undefined, 'mcp')` | `null` |
| `('true', 'mcp')` | `null` |

**The line that produces the MCP-disabled result** is the `enabled` expression, false only for `'mcp'`, quoted verbatim:

```javascript
  return { enabled: from !== 'mcp', stored: true, source: from };
```

There is no separate `source === 'mcp'` return. Plan 70-02 replaces this one line (D-04), not shadows it.

Test lines that pin its text or its MCP result (the cases D-05 inverts):
- `tests/jev-fast-start-path.test.js:221-222`: `(true, "mcp") -> {enabled:false, stored:true, source:"mcp"} (run_task never fast-steps)`.
- `tests/jev-fast-start-path.test.js:444-448`: `fsbRecomputeFastModeForFollowUp(session, 'mcp')` then `session.fastMode` deep-equals `{enabled:false, stored:true, source:'mcp'}` ("a run_task follow-up gets enabled:false"). So yes, a `fsbRecomputeFastModeForFollowUp` test passes `'mcp'`.
- `tests/jev-fast-start-path.test.js:12` header comment: "a run_task start (source 'mcp') gets enabled:false and never fast-steps".
- `tests/jev-fast-start-path.test.js:223-225`: `[false,'mcp']` gives null (stays true after D-04).
- `tests/jev-fast-start-path.test.js:556-562`: the exact line `const fastModeField = fsbFastModeSessionField(storedSettings.fsbJevFastModeEnabled, source);` and its position.
- `tests/jev-fast-loop.test.js:139-143`: extracts the helper by name (used only with `false`, :226).
- `tests/jev-extension-boundary.test.js:444` holds a probe line `const field = fsbFastModeSessionField(storedSettings.fsbJevFastModeEnabled, source);` inside a planted boundary self-test sample (not read from background.js).

## b. `FsbFastPath`

**Export key list** (21, `jev-fast-path.js:2108-2130`, `api` is not frozen): `constants, classifyFallback, toBuilderInput, evaluateDecision, buildStaticCall, classifyStepEvidence, isNoProgress, describeEscalation, buildHandoffMessage, collapseEarlierHandoffs, ensureMeasurement, appendAttempt, addCommandTotals, attemptFromResult, beforeTurn, afterStep, observeTools, flushHandoff, latchOff, abortInFlight, noteCaptureObservation`.

**`constants` key list and values** (19 keys, deep-frozen literal `var constants = deepFreeze({` at `jev-fast-path.js:40-60`): `MENU_CAP 48, FAST_MAX_STEPS 12, FAST_MAX_CALLS 16, FAST_WALL_BUDGET_MS 20000, FAST_MAX_CONSECUTIVE 3, FAST_ESCALATION_LATCH 3, MENU_DEADLINE_MS 1500, SNAPSHOT_DEADLINE_MS 3000, RECENT_ACTIONS_MAX 10, MEASUREMENT_ATTEMPTS_MAX 100, KINDS ['operation','target','completion','stuck'], ELEMENT_OPS ['click','check_box','press_enter','hover'], PAGE_OPS ['scroll','go_back'], NEVER_OFFERED ['type_text','select_option'], VAULT_TOOL_NAMES ['fill_credential','use_payment_method','list_credentials','list_payment_methods'], FAST_VISUAL_REASON 'Fast mode: simple step', SUMMARY_PREFIX 'FAST MODE HAND-OFF', SNAPSHOT_HEADER 'Current page snapshot (these refs replace any earlier refs):', SNAPSHOT_COLLAPSED '(Snapshot removed: a later fast-mode hand-off carries the current page.)'`.

**Pins (RESEARCH A2):**
- The `constants` key set IS deep-equal pinned: `tests/jev-fast-path.test.js:269-297`, check "constants holds exactly the documented keys" at :295 (`sameJson(sortedKeys(c), Object.keys(expected).sort())`), plus a frozen check at :296-297. A2 is false for `constants`: plan 70-02 adds `BUDGET_PROFILES` (or its chosen name) as a sibling export, never nested in `constants`, so this pin does not move.
- The export key list is NOT deep-equal pinned anywhere in `tests/`. `tests/jev-fast-path.test.js:1345` only checks that `beforeTurn`, `flushHandoff`, `latchOff` and `abortInFlight` are functions. New sibling exports need no pin bump.
- The boundary suite's exact-globals check (`tests/jev-extension-boundary.test.js:708-716`, `inertTogether`) counts globals (`FsbFastPath`), not members.

**beforeTurn step locations** (68-05 letters; the steps live in `attemptStep`, see Drift substitution 1):
- step g, consecutive cap: `jev-fast-path.js:1328` `if (jevFast.consecutiveFast >= constants.FAST_MAX_CONSECUTIVE) return await declineWith(session, deps, 'consecutive_cap');` (a decline, no latch).
- step h, budgets: `:1329-1330` `var budget = budgetReason(jevFast); if (budget !== null) return await declineWith(session, deps, latchCommand(jevFast, budget));` with `budgetReason` at `:1112-1117` returning exactly `'step_budget'` (`FAST_MAX_STEPS` :1113), `'call_budget'` (`FAST_MAX_CALLS` :1114) or `'time_budget'` (`FAST_WALL_BUDGET_MS` :1115). These are command latches (`jevFast.latched`).
- step o, goal: `:1378-1385`, `toBuilderInput(menu, { goal: session.task, ... })` with `goal: session.task` at `:1381`.
- step q, time left: `:1404` `var remaining = constants.FAST_WALL_BUDGET_MS - jevFast.jevMs;`, `:1405` `if (!(remaining > 0)) return await declineWith(session, deps, latchCommand(jevFast, 'time_budget'));`; the decide deadline `:1411` `var timeoutMs = Math.min(decideTimeoutLimit(), remaining);` (`decideTimeoutLimit` :995-999 reads `FsbJevClient.DEFAULT_TIMEOUT_MS`, fallback `FALLBACK_DECIDE_TIMEOUT_MS = 2500` :960).
- step t, escalation: `:1476-1479` `applyEscalation(...)` then decline; `applyEscalation` at `:1241-1251` reads `FAST_ESCALATION_LATCH` at `:1248` and latches the command `'escalation_latch'`.
- step u, act: `:1481-1499` (`jevFast.steps += 1; jevFast.consecutiveFast += 1;` then `return { toolCall: call, step: {callId, name, op, handle, role, label, url, signature, generation, iteration, command} }`). `iteration` comes from `indexOrNull(c.iteration)` at `:1387`.
- step v, flush helper: `deliverPending(session, deps, reason)` at `:1172-1208`; the snapshot request `:1187-1197`, the delivered-snapshot condition `isObject(answer) && answer.success === true && typeof answer.markdownSnapshot === 'string' && answer.markdownSnapshot.length > 0` at `:1191`; the exported `flushHandoff` `:1218-1228` calls it.

**Every read of the five budget names in the module:**

| Name | Declaration | Reads |
| --- | --- | --- |
| `FAST_MAX_STEPS` | `:42` | `:1113` (budgetReason, step h) |
| `FAST_MAX_CALLS` | `:43` | `:1114` (budgetReason, step h) |
| `FAST_WALL_BUDGET_MS` | `:44` | `:1115` (budgetReason, step h); `:1404` (step q remaining) |
| `FAST_MAX_CONSECUTIVE` | `:45` | `:1328` (step g) |
| `FAST_ESCALATION_LATCH` | `:46` | `:1248` (`applyEscalation`, step t); `:1664` (`afterStep`'s escalation counter after an uncertain, stale, failed or denied step) |

`observeTools` reads none; `answeredStates` has no bound; no other helper reads them. The only declaration sites are the five keys inside the `constants` literal (`:40-60`); there is no module-level alias variable for any of them. Plan 70-02's module-wide static check cuts out exactly that literal.

## c. Latch reasons and the measurement layout

- **Session latches** live in `session._fastPath`: `off`, `offReason`, `offCommand` (`latchOff` :1091-1104; a `switch_off` latch from an earlier command is cleared on a new command, :1067-1071). Reasons seen: `exception`, `unavailable`, `switch_off`, every session-class fallback (`invalid_request`, `invalid_response`, the six non-transient reasons, `unknown_fallback`), `not_calibrated`, `operation_malformed`, `target_malformed`, and (WR-04) any decide fallback before a calibrated answer.
- **Command latches** live in `session.agentState.jevFast.latched` (`latchCommand` :1107-1110, first reason kept): `step_budget`, `call_budget`, `time_budget`, `vault_flow`, `no_progress`, `sensitive_goal`, `local_invalid_request`, `escalation_latch`.
- **Real `_fastPath` layout** (`fastPathOf` :1011-1034): `{off, offReason, offCommand, inFlight, pendingSteps, stopReason, uncertain, recent, refEpoch, docEpoch, calibratedSeen}`; capture adds `capturePending` lazily (:1944, `finalizeCapture` :2066-2077). `lastLlmTools` is gone (IN-01, `481a2d5c`); `calibratedSeen` was added (WR-04, `73ee0523`).
- **Real `agentState.jevFast` layout** (`commandStateOf` :1042-1073): `{command, llmTurnSeen, yieldToLlm, consecutiveFast, consecutiveEscalations, steps, calls, jevMs, latched, lastStep, previousStep, firstUrl, firstTabId, vaultFlow, answeredStates}`; `firstTabId` was added (IN-04, `b608f8d3`); capture adds `captureArmed`, `captureFirstTabId`, `captureFirstUrl` lazily (:1890-1897, :1931-1935).
- **`session.jevMeasurement`** (`ensureMeasurement` :830-837): `{v:1, attempts:[...], commands:[...]}`, each list capped at `MEASUREMENT_ATTEMPTS_MAX` (100).
  - Attempt keys (`attemptFromResult` :858-896), in order: `iteration, command, decisionSource ('jev'), jevCalled, servedModel, instrumentVersion, calibrationStatus, latencyMs, usage {inputTokens, source}, cost {usd, source}, fallback, outcome ('acted'|'escalated'|'declined'|null), escalationReason, op, stepOutcome`. Key path for the calibration status: `jevMeasurement.attempts[i].calibrationStatus` (one of `calibrated`, `uncalibrated`, `snapshot_changed`, or null).
  - Per-command totals (`addCommandTotals` :905-938): `{command, fastSteps, jevCalls, jevMs, usd: {provider, estimate}, escalations: {<reason>: n}}`. The `escalations` map key is the reason code when it matches `^[a-z][a-z0-9_]{0,63}$`, else `other`. `jevMs` here is the decide time only (68-05 deviation 7); the budget's `jevFast.jevMs` is menu plus decide time.

## d. `describeEscalation`

An inspectable object table, not a switch: `ESCALATION_TEXT` (`jev-fast-path.js:552-608`) holds `disabled, not_configured, invalid_request, payload_too_large, sensitive_goal, busy, spend_cap_reached, timeout, rate_limited, upstream_overloaded, auth_error, upstream_billing, unavailable_model, upstream_rejected, upstream_error, invalid_response, network_error, aborted, server_error, unknown_fallback, not_calibrated, jev_stuck, completion_unconfirmed, op_not_offered, op_not_in_element_ops, page_op_with_target, unknown_target, risk_excluded, not_fast_eligible, stale, uncertain, dispatch_unconfirmed, failed, denied, no_effect, no_progress, same_state, step_budget, call_budget, time_budget, consecutive_cap, escalation_latch, vault_flow, switch_off, menu_unavailable, menu_invalid, nothing_offerable, local_invalid_request, exception, unavailable`. `operation_<reason>` and `target_<reason>` come from `CHOICE_TEXT` (:611-630; reasons `not_ok, not_calibrated, kind_absent, threshold_null, below_threshold, catch_all, malformed`). An unknown code gets the generic sentence `'Fast mode stopped and handed this step back to you.'` (`GENERIC_ESCALATION` :632; `describeEscalation('zz_unknown_code')` returns it).

## e. Lazy tool-registry lookup and the page-reading tools

- Lookup: `function toolRegistry()` at `jev-fast-path.js:1999-2010`: `if (typeof TOOL_REGISTRY !== 'undefined') return Array.isArray(TOOL_REGISTRY) ? TOOL_REGISTRY : null;` else `require('./tool-definitions.js')` and its `TOOL_REGISTRY` when it is an array; any throw gives null. `toolDefinitionOf(name)` (:2012-2019) scans it. Nothing runs at load.
- `TOOL_REGISTRY` is an array of 57 definitions (`require('./extension/ai/tool-definitions.js').TOOL_REGISTRY`).
- `_readOnly === true` (19): wait_for_element:content, wait_for_stable:content, read_sheet:content, capture_screenshot:cdp, read_page:content, get_text:content, get_attribute:content, get_dom_snapshot:content, list_tabs:background, get_page_snapshot:content, get_site_guide:background, search_memory:background, report_progress:background, complete_task:background, partial_task:background, fail_task:background, stop_trigger:background, get_trigger_status:background, list_triggers:background.
- `_readOnly === true` and `_route` in {'content','cdp'} (9, sorted): `capture_screenshot, get_attribute, get_dom_snapshot, get_page_snapshot, get_text, read_page, read_sheet, wait_for_element, wait_for_stable`. Exactly the RESEARCH F1 set. MATCH.
- `fill_payment_method` and `invoke_capability` are not in `TOOL_REGISTRY` (F7).
- Note for 70-03: autopilot runs `get_page_snapshot`, `search_memory`, `get_site_guide`, `report_progress` and the three terminal tools inside agent-loop.js itself (:2435-2699), not through `_executeTool`; `get_page_snapshot`'s result is `{success, hadEffect:false, error, navigationTriggered:false, result:{snapshot, elementCount}}` (:2443-2449) and it still reaches the AFTER_TOOL_EXECUTION emit.

## f. `classifyStepEvidence` semantics and the two human-gate shapes

Real calls (`require('./extension/ai/jev-fast-path.js').classifyStepEvidence`):

| op | toolResult | Verdict |
| --- | --- | --- |
| click | `{success:false, result:{outcome:'unknown'}}` | `{outcome:'uncertain', reason:'uncertain'}` |
| click | `{success:false, result:{mayHaveExecuted:true}}` | `{outcome:'uncertain', reason:'uncertain'}` |
| click | `{success:true, result:{bfCacheDetected:true}}` | `{outcome:'uncertain', reason:'uncertain'}` |
| click | `{success:true, result:{outcome:'unknown'}}` | `{outcome:'unconfirmed'}` (unknown read only on failure) |
| click | `{success:true, result:{mayHaveExecuted:true}}` | `{outcome:'unconfirmed'}` (mayHaveExecuted read only on failure) |
| click | `{success:false, result:{bfCacheDetected:true}}` | `{outcome:'failed'}` (bfCacheDetected read only on success) |
| click | `{success:true, result:{verification:{verified:true}}}` | `{outcome:'progress', effectObserved:true}` |
| click | `{success:true, result:{}}` | `{outcome:'unconfirmed'}` |
| navigate | `{success:false, error:'Unknown tool: navigate', result:null}` | `{outcome:'uncertain', reason:'dispatch_unconfirmed'}` |
| click | `{success:false, error:'Tool not permitted', result:null}` | `{outcome:'denied'}` |

So `outcome:'unknown'`/`mayHaveExecuted` are read only when `success` is false (`:501`) and `bfCacheDetected` only when `success` is true (`:504`): the 68-04 behaviour holds. **CHANGED part:** any toolResult that is not an object, and any failed result whose nested `result` is null (other than the two permission-denial texts, `:471-475`), is also `uncertain`, with reason `dispatch_unconfirmed` (`:497`, `:505-507`; 68-05 deviation 5). `makeResult` defaults `result` to null (`extension/ai/tool-executor.js:45-53`), so for LLM calls this covers ordinary background-route failures such as `Unknown tool: <name>`, a missing parameter or `Tab was closed or became inaccessible`, and agent-loop's own null-result failures (`search_memory requires a non-empty query`, `get_page_snapshot failed: ...`). See Drift substitution 3.

The hook's `toolResult` is `_executeTool`'s return unchanged: `result = await _executeTool(call.name, call.args, actionOpenerTabId, {...})` at `agent-loop.js:2751-2757`, then `toolResult: result` in the AFTER emit at `:2915-2919` (the only changes in between are the capture_screenshot attachment store `:2766-2784` and the open_tab binding failure `:2787-2834`, neither on a gate tool).

- **f1. fill_payment_method decline.** `extension/ai/tool-executor.js:573-582` returns `makeResult({ success: false, hadEffect: false, error: null, result: { declined: true, reason: confirmationResult.reason || 'user_declined' } })` (reasons `timeout` :539, `user_declined` :551, `sidepanel_unavailable` :569); `makeResult` (`:45-53`) keeps `result` as given. **Key path `toolResult.result.declined === true`.** Status: MATCH. Real verdict of that result: `classifyStepEvidence('fill_payment_method', r).outcome === 'failed'` (not uncertain). Reachability: `fill_payment_method` is not in `TOOL_REGISTRY`, so autopilot's `executeTool` answers `Unknown tool: fill_payment_method` (`tool-executor.js:847-854`) and the gate is unreachable from a real run_task today (F7).
- **f2. invoke_capability consent refusal.** `extension/utils/capability-router.js` `_err(code, extra)` at `:61-69` returns `{success:false, code, errorCode:code, error:code, ...extra}`; the consent gate returns it verbatim (`var gErr = ... _err('RECIPE_CONSENT_REQUIRED', { origin: c.origin || null, slug: slug }); ... return gErr;` at `:811-813`; other `RECIPE_CONSENT_REQUIRED` sites :456, :493, :503, :519, :529). `executeCapabilityToolForAutopilot` wraps it at `tool-executor.js:805-811`: `makeResult({ success, hadEffect: success && name === 'invoke_capability', error: success ? null : (response?.error || response?.errorCode || null), result: response })`. **Key path `toolResult.result.code === 'RECIPE_CONSENT_REQUIRED'`** (also `toolResult.result.errorCode`, and `toolResult.error === 'RECIPE_CONSENT_REQUIRED'`). Status: MATCH. Real verdict: `outcome:'failed'`. Reachability: `invoke_capability` is out-of-registry and reaches `executeTool`'s capability front door (`CAPABILITY_TOOL_NAMES` :677, guard :843-845) only if the LLM calls it (F7).

## g. The 68 tests D-05 inverts (and the cases D-22 touches)

- **`(true,'mcp')` helper case** (68-06-PLAN.md:108): `tests/jev-fast-start-path.test.js:221-222`, check name `'(true, "mcp") -> {enabled:false, stored:true, source:"mcp"} (run_task never fast-steps)'`, section `fsbFastModeSessionField (D-01, D-03, D-05)` (:213). Companion follow-up case `:444-448` ("a run_task follow-up gets enabled:false") and header comment `:12`.
- **jev-fast-loop run_task case** (68-06-PLAN.md:190): `tests/jev-fast-loop.test.js:611-637`, `async function runTaskCase()`, section `'run_task: fastMode {enabled:false, source:"mcp"} stays on the golden path apart from one capture arm read (D-03, D-22)'` (:612), harness `sessionPatch: { fastMode: { enabled: false, stored: true, source: 'mcp' } }` (:623); header bullets `:36` and `:62`. Its checks: "the run_task session carries enabled:false" (:625), "run_task: the command reads the capture arm exactly once and never the tab url (unarmed)" (:631), "run_task: nothing is written to storage" (:632), "run_task: apart from that one read, ... equal the golden" (:633-634), "run_task: no menu request and no decide call" (:635-636).
- **68-08 capture cases naming run_task** (68-08-PLAN.md:103-104): all in `tests/jev-fast-path.test.js`, built on `const RUN_TASK_FIELD = Object.freeze({ enabled: false, stored: true, source: 'mcp' });` (:2458): `labelOf` (:2549-2557, used by `captureLabels` :2769), `captureNoCaptureDeps` (:2559-2570, "capture: deps without readCaptureArm, ... make no call for a run_task session"), `captureRunTask` (:2572-2592, "capture: a run_task session still declines not_enabled", "capture: a run_task capture never asks Jev and takes no snapshot", "capture: a captured run_task session never calls decide"), `captureGateCost` (:2594-2631, "capture gate cost: an unarmed run_task command reads the arm once ..."), `captureGateRules` (:2633-2690, including `{enabled:false, stored:false, source:'mcp'}` at :2661), `captureRecordShape` (:2779), `captureMenuDrops` (:2811), `captureObservationShape` (:2819), `captureNeverRejects` (:2853). Also outside that file: `tests/jev-fast-start-path.test.js:984-992` ("capture end to end: the run_task iteration holds a capture ..." with `fastMode: { enabled: false, stored: true, source: 'mcp' }` :984) and `tests/jev-fast-capture.test.mjs:122-150` (`moduleRing`, "a run_task bench session", :150). None is in `tests/jev-fast-loop.test.js` beyond `runTaskCase`.
- **68-05 `not_enabled` case** (68-05-PLAN.md:99): `tests/jev-fast-path.test.js:1377-1400`, `async function orchNotEnabled()`, session `fastSession({ fastMode: { enabled: false, stored: true, source: 'mcp' } })` (:1385), check name `'a run_task session declines not_enabled at iteration ' + i` (:1389). D-05 keeps it as a module-level case for a hand-built `enabled:false` field, renamed so it no longer claims to be run_task.
- **68-05 bench-goal `sensitive_goal` case** (68-05-PLAN.md:103): `tests/jev-fast-path.test.js:1520-1531` inside `async function orchFallbacks()` (:1505), goal `BENCH_GOAL` (:1181-1182), check `'a bench-like goal holding a run token latches the command sensitive_goal with zero decide calls'` (:1525-1526). Its rig's menu url is `https://example.test/wizard/step-2?token=abc#frag` (`menuOf` :115-128, `MENU_URL` :1183), which is not the Open URL. Two more bench-goal `sensitive_goal` cases exist: `tests/jev-fast-loop.test.js:719-720` (`BENCH_GOAL`) used at `:951-962` ("fallback sensitive_goal: ..."; harness `pageUrl` default `https://wizard.example/start`, `tests/fixtures/agent-loop-fast-harness.js:112-119`) and `tests/jev-fast-measurement.test.js:754-755` (`PARITY_SENSITIVE_GOAL`, page `PARITY_URL = 'https://mkr.example/wizard/step-2'`) asserted at :1005-1027. In all three the page url differs from the Open URL, so D-22's page-match condition (1) declines and they stay latched unless a case moves the page to the Open URL (Drift substitution 8).

## h. The 68 loop harness

- Option list (`tests/fixtures/agent-loop-fast-harness.js:211-222`, `function createHarness(options)` :223): `providerKey, model, task, pageUrl, tabId, sessionId` (defaults in `DEFAULTS` :112-119), `loadFastPath`, `sessionPatch`, `contentResponder(message, options)`, `providerScript`, `deps`, `jevResponder`, `jevClient`, `permissionDenies`, `storage`.
- HookPipeline: real (`new HookPipeline()` :407) with the real safety-breaker hook on BEFORE_ITERATION (:408) and the real permission hook over a real `PermissionContext` on BEFORE_TOOL_EXECUTION (:409); the progress hook is left out. The pipeline is exposed as `harness.pipeline` and the context as `harness.permissionContext` (returned object :548-572). `permissionDenies` overrides `isAllowed` on that one instance (:402-406).
- `globalThis.fsbBroadcastAutomationLifecycle` is replaced (:368-371) by a recorder that pushes `{type:'lifecycle', message: normalise(clone(message), null)}` into `harness.events` and returns `Promise.resolve()`; it does not dispatch on any bus. `dispose()` restores it (:540-546).
- Switch-off golden: `tests/fixtures/jev-fast-loop-off-golden.json` (keys `about, capturedFromAgentLoopSha256, events, final`), the scenario `runGoldenScenario` (:596-604; click by selector, get_page_snapshot, complete_task). Run names used with `matchesGolden(record, label)` in `tests/jev-fast-loop.test.js`: `'run A'` (:186), `'run B'` (:220), `'run C'` (:235), `'run_task'` (:633), `'run A again'` (:1897).

## i. Boundary-suite rules as narrowed by 68 (`tests/jev-extension-boundary.test.js`)

- Enumerated modules `jev-state.js`, `jev-client.js`, `jev-policy.js` plus `FAST_PATH_MODULE = {file:'jev-fast-path.js', global:'FsbFastPath'}` (`MODULES` :74-78, :82-84); `extension/ai` must hold exactly these jev-*.js files.
- Module bans over all four modules (`MODULE_PATTERNS` :95-100): `chrome.storage`, `localStorage`, `serverUrl` (case-insensitive), `importScripts`.
- Tree bans over every file under `extension/` (`TREE_PATTERNS` :88-92): `systemone`, `api.typesafe.ai`, `\bJEV_[A-Z_]+\b`.
- One-URL scan (`URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)<>\]]*/gi` :151): across the four modules exactly one `<scheme>://` literal, the endpoint in jev-client.js; comments count. A regex written `https?:\/\/` (escaped slashes) does not match.
- Caller rule (`CALLER_PATTERN /FsbJev[A-Za-z_$]*/g` :103): nothing outside the modules names `FsbJevState`, `FsbJevClient` or `FsbJevPolicy`; `FsbFastPath` carries no `FsbJev` prefix and needs no exemption (bridge and background may name `FsbFastPath`).
- background.js: the lines matching `/jev/i` are exactly the four load lines in order directly after `importScripts('ai/model-discovery.js');`, plus the exact word-bounded tokens `BACKGROUND_JEV_TOKENS` (:140-146): `fsbJevFastModeEnabled`, `getJevMenu`, `fsbJevCaptureArmed`, `fsbJevCaptureRing`, `jevCaptureObservation`. Any other `jev` text in background.js, a comment included, fails.
- `/\bjev\b/i` and `/jev/i` scope (`UI_WORD_PATTERN`/`UI_TEXT_PATTERN` :106-107): files under `extension/ui` and `extension/config`; the token `fsbJevFastModeEnabled` is stripped only in `config.js`, `init-config.js`, `options.js` (`UI_CONFIG_TOKEN_FILES` :117-122); `control_panel.html` allows jev text only between `id="fsbJevFastModeCard"` and `<!-- /fsbJevFastModeCard -->` (at most 40 lines, :130-133).
- Inert loads: each module alone and all four together add exactly their own Fsb* global, make no timer call and log nothing (`inertTogether` :708-716).

## j. Disclosure fixture, card and privacy section

- Fixture exports: `SHARED_PHRASES` (29), `CARD_ONLY_PHRASES` (2), `PAGE_ONLY_PHRASES` (6), `FORBIDDEN_PATTERNS` (4), `ENFORCEMENT` (4, including WR-04's "one step description"), `textOf(html)`. No exported phrase covers the Control fact.
- Card markers: `extension/ui/control_panel.html:636` (`<div class="settings-card" id="fsbJevFastModeCard">`) and `:665` (`<!-- /fsbJevFastModeCard -->`); 30 lines.
- Privacy-section markers: from `<h2 id="jev-fast-mode" i18n="@@privacy.section.jevFastMode.title">` (`showcase/angular/src/app/pages/privacy/privacy-page.component.html:63`, comment `<!-- Jev fast mode (Phase 68) -->` at :62) up to the next `<h2` (`<h2 id="local-service"` at :97); the same slicing as `tests/showcase-privacy-page.test.js:285-289`.
- **Control-fact sentence** (`@@privacy.section.jevFastMode.control`, `privacy-page.component.html:65`), as a reader sees it (the inline `<span [attr.translate]="'no'">` wrappers unwrapped first, as the 68-10 alignment test does):
  > An MCP client connected to FSB can also change this setting through FSB's settings tool.

  Plain `textOf` of the section gives `An MCP client connected to FSB can also change this setting through FSB 's settings tool.` (a space before the apostrophe, because `textOf` turns the closing `</span>` into a space; 68-10 SUMMARY deviation 1). The regex `/\bMCP\b[^.]*\bsettings tool\b/i` matches both forms. Status MATCH, so plan 70-04 Task 2 does not take its MISSING path.
- **Card and MCP:** the card text (`textOf` of the card range) mentions neither `MCP` nor `settings tool` (recorded for M-70-09, never a failure). It describes fast mode as "during autopilot" and "FSB's autopilot sends a short description of the current step"; it contains no phrase limiting fast mode to the side panel.

## k. 68-08 exporter goal rule

`scripts/bench/shadow/export-capture.mjs`: `const START_PREFIX = 'Open {startUrl}.';` (:78) and

```javascript
function goalOf(task) {
  if (typeof task.instruction !== 'string' || !task.instruction.startsWith(START_PREFIX)) return null;
  const goal = task.instruction.slice(START_PREFIX.length).trim();
  return goal.length > 0 && goal.indexOf('{startUrl}') === -1 ? goal : null;
}
```

(:146-150). It reads the unrendered corpus instruction (with the `{startUrl}` placeholder) and trims both ends. `goalOf` is **not exported**; the module exports `DEFAULT_OUT_DIR, MAX_PER_SLUG, STAND_IN_ORIGIN, deriveRecords, main, parseArgs` (`deriveRecords(ring, {tasks, lock, run, since})` at :198, which calls `goalOf` at :238). All 12 core instructions (`scripts/bench/tasks/core/*.json`) start with `Open {startUrl}. `, contain `{startUrl}` exactly once and have no trailing whitespace, so `trimStart` of the rendered remainder equals `goalOf` for every core task. Bench rendering is `renderInstruction(task, startUrl)` (`scripts/bench/lib/tasks.mjs:461-471`, a plain split-and-join on `{startUrl}`).

## l. 67 scrubber and the F5 probe

Signatures (`extension/ai/jev-state.js`, `root.FsbJevState = api` :958, `module.exports = api` :959): `scrubText(s)` (:277-284; non-strings pass through), `matchesSecret(s)` (:287-289, `typeof s === 'string' && scrubText(s) !== s`), `buildRequest(input, options)` (:763-939; `options.byteBudget`, default `CONTRACT.BUDGETS.requestByteBudget`; returns `{ok:true, request, idMap, stats}` or `{ok:false, reason:'invalid_request'|'sensitive_goal'}`; the secret scan runs on the untruncated goal at :780), `toOriginPath(url)` (:672-680; `{origin, path}` with each path segment passed through `scrubPathSegment` :657-663, which is `scrubText(segment)` plus, for a segment containing `%`, a `matchesSecret` check on its `decodeURIComponent` form; any other scheme or an unparseable URL gives null). `scrubPathSegment` is not exported.

**Goal length (CHANGED):** `buildRequest` truncates the goal to 1000 code points (`var goal = truncateCodePoints(input.goal, CAPS.goalChars);` :851) and then validates the truncated request; a 1001-, 2000- or 5000-character goal returns `ok:true` with a 1000-code-point goal (probe at P70_START; also pinned by `tests/jev-state.test.js:587` "goal truncated to 1000 code points"). Only `validateRequest` (:373, and the server mirror `showcase/server/src/jev/validator.js:80`) refuses an over-cap goal, and buildRequest never sends it one. See Drift substitution 7.

**F5 probe** (URL `http://127.0.0.1:53211/r/<token>/fixtures/checklist/index.html`, goal `Open <url>. Tick Alpha.`):

| Token | `matchesSecret(goal)` | `scrubText(segment) === segment` for `''`, `r`, token, `fixtures`, `checklist`, `index.html` | `toOriginPath(url)` | `buildRequest` with the full goal | `buildRequest` with goal `Tick Alpha.` |
| --- | --- | --- | --- | --- | --- |
| `Ab3dEf9hIj2kLm5nOp8qRs` (22-char base64url) | **true** (`scrubText(goal)` = `Open http://127.0.0.1:[REDACTED_TOKEN].html. Tick Alpha.`) | true for every segment | `{origin:'http://127.0.0.1:53211', path:'/r/Ab3dEf9hIj2kLm5nOp8qRs/fixtures/checklist/index.html'}` | `{ok:false, reason:'sensitive_goal'}` | `ok:true` |
| `qwertyuiopasdfghjklzxcvb` (24 lowercase letters) | **false** | true for every segment | `{origin:'http://127.0.0.1:53211', path:'/r/qwertyuiopasdfghjklzxcvb/fixtures/checklist/index.html'}` | `ok:true` | `ok:true` |

The 22-character token is **not** redacted per segment, so D-22's normaliser will not decline on bench goals because of condition (2), and plan 70-04 Task 1 does **not** take its recorded-redaction branch: both token shapes' sub-checks expect the normalised goal to equal the exporter goal. The whole-goal rule fires on the 22-character shape only because the high-entropy class spans the `:53211/r/<token>/fixtures/...` run. Extra probe: over 5,000 tokens drawn exactly as the bench draws them (`randomBytes(16).toString('base64url')`, `scripts/bench/fixture-server.mjs:416`), 0 token segments were changed by `scrubText` and 3,457 of the 5,000 full goals matched `matchesSecret`, so about 69% of current bench goals trip `sensitive_goal` today and the normaliser makes them sendable.

## m. 69 caller harness and the MCP success passthrough

- `tests/helpers/mcp-in-process.mjs` re-exports `scripts/mcp/lib/tools-list.mjs` (`export *` :16) and adds `assertBuildFresh()` (:51), `listCurrentTools()` (:71) and `EXPECT_TOOL_NAMES_VERBATIM` (:22). Dynamic import gives `createInProcessClient` (`({ runtimePath = DEFAULT_RUNTIME_PATH, bridge, agentScope } = {})`, tools-list.mjs:70), `makeStubBridge` (`({ onSend } = {})` with `calls` of `{message, options}`, :56-68), `makeMockAgentScope()` (:43), `assertBuildFresh`, plus `loadSdk`, `listToolsFromRuntimeModule`, `REPO_ROOT` and others.
- Files: `tests/mcp-tools-list-shape-freeze.test.js`, `tests/mcp-expect-caller.test.mjs` and `tests/mcp-expect-wire.test.js` exist.
- `mcp/src/errors.ts:469-475`: `export function mapFSBError(fsbResult, context?)`, and its first branch is `if (fsbResult && fsbResult.success) { return { content: [{ type: 'text', text: JSON.stringify(fsbResult, null, 2) }] }; }` (:473-475). `mcp/build/errors.js` and `mcp/build/runtime.js` are present (gitignored, built).

## Regression-sweep baseline

`node scripts/bench/sweep-tests.mjs --files extension/background.js extension/ws/mcp-bridge-client.js extension/ai/jev-fast-path.js scripts/bench/run-bench.mjs --out .planning/phases/70-bounded-mcp-fast-task/70-SWEEP-BASELINE.json` ran in the background at P70_START before any edit (Node v24.14.1; port 7225 held by the user's hub, untouched; started 13:44:39Z, finished 13:46:48Z). Result: **110 of 110 selected tests passed, exit 0, `failures: []`**. No pre-existing failure among the selected tests. `tests/showcase-build-smoke.test.js` was not selected, and `git status --short showcase/angular/public` printed nothing afterwards.
