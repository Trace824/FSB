#!/usr/bin/env node
'use strict';

/**
 * Phase 68 Plan 06 -- fast mode inside the real autopilot loop (D-01, D-08,
 * D-09, D-10, D-19, F1, F13, F21; AUTO-01..AUTO-05).
 *
 * tests/fixtures/agent-loop-fast-harness.js drives the real runAgentIteration
 * with a scripted provider, a recording content script and the real hook
 * pipeline. The suite proves:
 *
 *   - off golden: with the fast-path module not loaded and no session.fastMode,
 *     the golden scenario (click by selector, get_page_snapshot,
 *     complete_task) produces exactly tests/fixtures/jev-fast-loop-off-golden.json,
 *     which was captured from agent-loop.js before any fast-path seam existed;
 *   - off three-way: with the module loaded and no field, and with the module
 *     loaded and a session built from fsbFastModeSessionField(false) (still no
 *     field), the run is identical to that golden, and no fast-path dependency
 *     (menu, snapshot, switch, clock, decide) is touched;
 *   - slice hashes: buildSystemPrompt, getPublicTools, checkSafetyBreakers and
 *     detectStuck are byte-identical to P68_START (68-SYNC-RECHECK.md item h);
 *   - seam 1 guard shape: with the field absent the only new code before
 *     buildTurnMessages is a declaration, a falsy guard and one falsy test
 *     (no new await, no new return, no status read);
 *   - accepted step: with fast mode on, the background.js dependencies over the
 *     harness's chrome stub and a fake calibrated gateway, the first iteration
 *     is the LLM's (no menu), the second runs one code-built click (or
 *     check_box) through the permission hook and the content script with no
 *     provider request and no tool message, and the third hands back to the
 *     LLM with exactly one FAST MODE HAND-OFF message and no unpaired tool call;
 *   - TOOL_DISPATCH on a fast iteration: the unchanged emission reports
 *     previousStepName 'LLM_TURN' and no LLM_TURN is emitted for it;
 *   - permission denial: the real permission hook refuses the fast click, no
 *     content action is sent and the hand-off says nothing ran;
 *   - first-turn rule: the first iteration of a follow-up command requests no menu;
 *   - run_task: a session with fastMode {enabled:false, source:'mcp'} equals the golden;
 *   - containment: a throwing or rejecting beforeTurn, a throwing afterStep or
 *     observeTools never reaches the API-error path, and a stop during the
 *     decision ends the iteration with no provider call and no schedule.
 *
 * Plan 68-07 adds, through the same harness:
 *   - latches and budgets (Task 1): the uncalibrated latch (one menu, one
 *     decide, then the switch-off path), fallback classes (session, command,
 *     iteration and the escalation latch), the four per-command budgets, the
 *     completion and stuck gates, the D-17 no-progress latch, never re-roll
 *     (same state), the existing maxIterations and meta-attempt breakers with
 *     the per-page meta key, and no terminal tool in any fast call.
 *   - outcomes, pairing and containment (Task 2): an unknown outcome,
 *     bfCacheDetected, a stale target, a closed message channel and no answer
 *     each dispatch once and escalate once with a truthful hand-off; request
 *     bodies stay paired for xai, openai, anthropic, gemini, openrouter,
 *     lmstudio and custom; earlier hand-off snapshots collapse; a throwing
 *     beforeTurn or afterStep never reaches the API-error handler; a stop
 *     during an in-flight decision aborts it and dispatches nothing; turning
 *     the switch off mid-run latches fast mode off.
 *
 * Only one harness is live at a time: createHarness installs its own chrome
 * and timer globals, and dispose() restores them.
 *
 * No network, no ports, no real waits. Node 20-safe.
 *
 * Run: node tests/jev-fast-loop.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const util = require('util');
const crypto = require('crypto');

process.exitCode = 1;

const ROOT = path.join(__dirname, '..');
const H = require('./fixtures/agent-loop-fast-harness.js');
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'jev-fast-loop-off-golden.json'), 'utf8'));
const agentLoopSource = fs.readFileSync(path.join(ROOT, 'extension', 'ai', 'agent-loop.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');

// 68-SYNC-RECHECK.md item h, copied as literals (this suite never reads .planning).
const SLICE_HASHES = Object.freeze({
  buildSystemPrompt: 'f6d32b22c09f2461c51deae48470b87ae00024d7af9bce8908931b60cb94a7e0',
  getPublicTools: 'fa75f080ceb92723ccac1b2d95ec8ff191d20ac6ee9bc59e5a68c1f2baa49706',
  checkSafetyBreakers: '8a74f88a3894fad05372592f88965d60ad218d023dc3330f320e2fcc1858374a',
  detectStuck: '4f51f466bef4d3036830cc39ba27669086889259958f3ad14ec0ae4af0027aea'
});

let passed = 0;
let failed = 0;

function check(cond, name) {
  if (cond) {
    passed += 1;
    console.log('  PASS: ' + name);
  } else {
    failed += 1;
    console.error('  FAIL: ' + name);
  }
}

function section(title) {
  console.log('\n--- ' + title + ' ---');
}

/** item h slicing: through the brace that closes the body after the parameter list. */
function sliceFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let i = source.indexOf('(', start);
  for (let depth = 0; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')' && --depth === 0) break;
  }
  let j = source.indexOf('{', i);
  for (let depth = 0; j < source.length; j += 1) {
    if (source[j] === '{') depth += 1;
    else if (source[j] === '}' && --depth === 0) break;
  }
  return source.slice(start, j + 1);
}

/** fsbFastModeSessionField from background.js, evaluated alone. */
function loadSessionFieldHelper() {
  const ctx = vm.createContext({});
  vm.runInContext(sliceFunction(backgroundSource, 'fsbFastModeSessionField'), ctx);
  return ctx.fsbFastModeSessionField;
}

/** Index of the first differing event, for a readable failure. */
function firstDifference(actual, expected) {
  const a = actual.events || [];
  const e = expected.events || [];
  for (let i = 0; i < Math.max(a.length, e.length); i += 1) {
    if (!util.isDeepStrictEqual(a[i], e[i])) {
      return 'event ' + i + ': got ' + JSON.stringify(a[i]).slice(0, 400) + ' expected ' + JSON.stringify(e[i]).slice(0, 400);
    }
  }
  if (!util.isDeepStrictEqual(actual.final, expected.final)) return 'final state differs: ' + JSON.stringify(actual.final).slice(0, 600);
  return null;
}

function matchesGolden(record, label, quiet) {
  const expected = { events: GOLDEN.events, final: GOLDEN.final };
  const ok = util.isDeepStrictEqual(record.events, expected.events) && util.isDeepStrictEqual(record.final, expected.final);
  if (!ok && !quiet) console.error('    ' + label + ' differs from the golden at ' + firstDifference(record, expected));
  return ok;
}

/** Fast-path dependencies that record every call (none may happen on the off path). */
function recordingDeps() {
  const calls = [];
  return {
    calls,
    deps: {
      now() { calls.push('now'); return 0; },
      readSwitch() { calls.push('readSwitch'); return Promise.resolve(false); },
      requestMenu() { calls.push('requestMenu'); return Promise.resolve(null); },
      requestSnapshot() { calls.push('requestSnapshot'); return Promise.resolve(null); },
      getTabUrl() { calls.push('getTabUrl'); return Promise.resolve(null); }
    }
  };
}

async function offGoldenCases() {
  section('off golden: module not loaded, no session.fastMode (D-01)');
  check(Array.isArray(GOLDEN.events) && GOLDEN.events.length > 0 && GOLDEN.final && GOLDEN.final.status === 'completed',
    'the golden holds a completed three-iteration run');
  const { record } = await H.runGoldenScenario({ loadFastPath: false });
  check(matchesGolden(record, 'run A'), 'off golden: run A equals tests/fixtures/jev-fast-loop-off-golden.json event for event');
  const providerEvents = record.events.filter((e) => e.type === 'provider');
  check(providerEvents.length === 3, 'run A makes three provider requests');
  check(record.events.filter((e) => e.type === 'schedule').length === 2, 'run A schedules two follow-on iterations');
  check(!('FsbFastPath' in globalThis), 'run A ran with no FsbFastPath global');

  // The comparison is not vacuous: one changed content answer, one extra
  // session message or one changed provider answer each break it.
  const changedSnapshot = await H.runGoldenScenario({
    loadFastPath: false,
    contentResponder: (message) => (message && message.action === 'getMarkdownSnapshot'
      ? { success: true, markdownSnapshot: '# Wizard (changed)', elementCount: 1 }
      : H.defaultContentResponder(message))
  });
  const extraMessage = await H.runGoldenScenario({
    loadFastPath: false,
    sessionPatch: { messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'FAST MODE HAND-OFF' }] }
  });
  const script = H.goldenProviderScript();
  script[0] = H.openAiToolResponse('resp_1', [{ id: 'call_1', name: 'click', args: { selector: '#other' } }]);
  const changedProvider = await H.runGoldenScenario({ loadFastPath: false, providerScript: script });
  check(!matchesGolden(changedSnapshot.record, 'changed snapshot', true)
    && !matchesGolden(extraMessage.record, 'extra message', true)
    && !matchesGolden(changedProvider.record, 'changed provider answer', true),
  'off golden: a changed content answer, an extra session message or a changed tool call each fail the comparison');
}

async function offThreeWayCases() {
  section('off three-way: module loaded, field absent (D-01)');
  const fieldFor = loadSessionFieldHelper();

  const b = recordingDeps();
  const runB = await H.runGoldenScenario({ loadFastPath: true, deps: b.deps, jevResponder: () => { b.calls.push('decide'); return new Promise(() => {}); } });
  check(runB.harness.fastPath && typeof runB.harness.fastPath.beforeTurn === 'function', 'run B loaded the real fast-path module');
  check(matchesGolden(runB.record, 'run B'), 'off three-way: run B (module loaded, no field) equals the golden');
  check(b.calls.length === 0, 'run B touched no fast-path dependency and made no decide call (' + b.calls.join(',') + ')');
  check(!runB.harness.contentMessages.some((m) => m.message && m.message.action === 'getJevMenu'), 'run B sent no getJevMenu message');
  check(!('_fastPath' in runB.harness.session) && !('jevMeasurement' in runB.harness.session), 'run B left no fast-path state on the session');

  const field = fieldFor(false, undefined);
  check(field === null, 'fsbFastModeSessionField(false, undefined) is null, so session C has no fastMode field');
  const c = recordingDeps();
  const runC = await H.runGoldenScenario({
    loadFastPath: true,
    deps: c.deps,
    jevResponder: () => { c.calls.push('decide'); return new Promise(() => {}); },
    sessionPatch: field ? { fastMode: field } : {}
  });
  check(!('fastMode' in runC.harness.session), 'session C carries no fastMode field');
  check(matchesGolden(runC.record, 'run C'), 'off three-way: run C (module loaded, switch false) equals the golden');
  check(c.calls.length === 0, 'run C touched no fast-path dependency and made no decide call (' + c.calls.join(',') + ')');
  check(!runC.harness.contentMessages.some((m) => m.message && m.message.action === 'getJevMenu'), 'run C sent no getJevMenu message');
  check(runC.harness.session.messages.length === GOLDEN.final.messages.length, 'run C added no session.messages entry');
  delete globalThis.FsbFastPath;
}

function sliceHashCases() {
  section('slice hashes: agent-loop.js functions Phase 68 must not touch (item h)');
  for (const name of Object.keys(SLICE_HASHES)) {
    const slice = sliceFunction(agentLoopSource, name);
    const hash = slice ? crypto.createHash('sha256').update(slice, 'utf8').digest('hex') : null;
    check(hash === SLICE_HASHES[name], 'slice hashes: ' + name + ' is byte-identical to P68_START (' + String(hash).slice(0, 12) + ')');
  }
}

// ---------------------------------------------------------------------------
// Fast mode on: fixtures
// ---------------------------------------------------------------------------

const gateway = require('./fixtures/jev-fake-gateway.js');
const FAST_FIELD = Object.freeze({ enabled: true, stored: true, source: null });
const WIZARD_URL = 'https://wizard.example/wizard/step-2';
const HANDOFF_PREFIX = 'FAST MODE HAND-OFF';

/** fsbCreateFastPathDeps from background.js, evaluated in this realm so chrome and the timers resolve to the harness's. */
function backgroundDepsFactory() {
  const code = '(function () {\n' + sliceFunction(backgroundSource, 'fsbFastPathWithDeadline') + '\n'
    + sliceFunction(backgroundSource, 'fsbCreateFastPathDeps') + '\nreturn fsbCreateFastPathDeps;\n})()';
  return vm.runInThisContext(code, { filename: 'background.js#fsbCreateFastPathDeps' });
}
const createBackgroundDeps = backgroundDepsFactory();

/** One 68-02 menu entry: a fast-eligible button unless overridden. */
function entry(handle, over) {
  return Object.assign({
    handle,
    role: 'button',
    label: 'Button ' + handle,
    ops: ['click', 'hover'],
    inputType: null,
    autocomplete: null,
    purpose: { sensitive: false, danger: false, intent: null },
    hidden: false,
    risk: null,
    fastEligible: true,
    vaultFilled: false,
    state: { checked: null, expanded: null, selected: null, pressed: null },
    inViewport: true
  }, over || {});
}

/**
 * A content script for the wizard page. Its menu signature and generation
 * change after every fast action it receives, so the D-17 no-progress latch
 * never ends a run here; it answers one null per recent descriptor.
 */
function wizardContent(state) {
  return function respond(message) {
    if (message && message.action === 'getJevMenu') {
      const n = state.fastActions + 1;
      const options = message.options || {};
      const entries = [
        entry('j1', { label: 'Next' }),
        entry('j2', { role: 'checkbox', label: 'Agree', ops: ['check_box'], inputType: 'checkbox',
          state: { checked: false, expanded: null, selected: null, pressed: null } })
      ];
      return {
        success: true,
        generation: 'gen' + n + 'abcd-' + n,
        url: WIZARD_URL,
        title: 'Wizard',
        visibleText: 'Step 2 of 3',
        moreBelow: false,
        signature: 'sig-' + n,
        count: entries.length,
        truncated: false,
        entries,
        recentHandles: (Array.isArray(options.recent) ? options.recent : []).map(() => null)
      };
    }
    if (message && message.action === 'executeAction' && message.params && message.params.jevHandle) {
      state.fastActions += 1;
      return { success: true };
    }
    if (message && message.action === 'getMarkdownSnapshot') {
      return { success: true, markdownSnapshot: 'SNAP-HANDOFF e1 button "Next"', elementCount: 1 };
    }
    return H.defaultContentResponder(message);
  };
}

function idByLabel(request, label) {
  const element = request.elements.find((e) => e.label === label);
  return element ? element.id : gateway.CATCH_ALL;
}

/** A calibrated gateway answer: op on the element labelled label. */
function calibrated(op, label) {
  return (request) => ({ body: gateway.calibratedBody(request, {
    operation: { choice: op },
    target: { choice: idByLabel(request, label) }
  }) });
}

/** A calibrated answer that picks none_of_the_above for both choices. */
function catchAll(request) {
  return { body: gateway.calibratedBody(request, {
    operation: { choice: gateway.CATCH_ALL },
    target: { choice: gateway.CATCH_ALL }
  }) };
}

/** The events of step n (from its step marker to the next one). */
function stepEvents(events, n) {
  const start = events.findIndex((e) => e.type === 'step' && e.index === n);
  if (start < 0) return [];
  let end = events.findIndex((e, i) => i > start && e.type === 'step');
  if (end < 0) end = events.length;
  return events.slice(start + 1, end);
}

function ofType(events, type) {
  return events.filter((e) => e.type === type);
}

function contentActions(events, action) {
  return ofType(events, 'content').filter((e) => e.message && e.message.action === action);
}

function handoffMessages(messages) {
  return (messages || []).filter((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.indexOf(HANDOFF_PREFIX) === 0);
}

/** Every assistant tool call has a tool reply with its id, and every tool reply answers a call. */
function toolCallsPaired(messages) {
  const callIds = [];
  const replyIds = [];
  for (const m of messages || []) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) callIds.push(c.id);
    if (m && m.role === 'tool') replyIds.push(m.tool_call_id);
  }
  return callIds.length === replyIds.length && callIds.every((id) => replyIds.includes(id));
}

/**
 * A fast-mode harness on the wizard page. opts: harness options plus
 * {answers: [responder per decide call], state}.
 */
function fastHarness(opts) {
  const o = opts || {};
  const state = o.state || { fastActions: 0 };
  const decideRequests = [];
  const answers = o.answers || [calibrated('click', 'Next'), catchAll];
  const h = H.createHarness(Object.assign({
    loadFastPath: true,
    storage: { fsbJevFastModeEnabled: true },
    sessionPatch: { fastMode: Object.assign({}, FAST_FIELD) },
    deps: createBackgroundDeps(),
    jevResponder: (request) => {
      decideRequests.push(request);
      const answer = answers[Math.min(decideRequests.length, answers.length) - 1];
      return answer(request);
    },
    contentResponder: wizardContent(state)
  }, o.harness || {}));
  return { h, state, decideRequests };
}

const LLM_CLICK = H.openAiToolResponse('resp_llm_1', [{ id: 'call_llm_1', name: 'click', args: { selector: '#start' } }]);
const LLM_SNAPSHOT = H.openAiToolResponse('resp_llm_1', [{ id: 'call_llm_1', name: 'get_page_snapshot', args: {} }]);
const LLM_DONE = H.openAiToolResponse('resp_llm_done', [{ id: 'call_llm_done', name: 'complete_task', args: { summary: 'Wizard finished' } }]);
const LLM_DONE_2 = H.openAiToolResponse('resp_llm_done_2', [{ id: 'call_llm_done_2', name: 'complete_task', args: { summary: 'Summary opened' } }]);

// ---------------------------------------------------------------------------
// Fast mode on: cases
// ---------------------------------------------------------------------------

function seamShapeCases() {
  section('seam 1 guard shape: the off path gains no await, no return and no status read (D-01)');
  const startToken = 'var _fastStep = null;';
  const endToken = 'var turnMessages = buildTurnMessages(session);';
  const startAt = agentLoopSource.indexOf(startToken);
  const endAt = agentLoopSource.indexOf(endToken);
  check(startAt >= 0 && endAt > startAt && agentLoopSource.indexOf(startToken, startAt + 1) === -1,
    'seam 1 guard shape: one var _fastStep = null; declared before buildTurnMessages');
  const slice = startAt >= 0 && endAt > startAt ? agentLoopSource.slice(startAt, endAt) : '';
  const guardAt = slice.indexOf('if (session.fastMode &&');
  let block = '';
  if (guardAt >= 0) {
    const open = slice.indexOf('{', guardAt);
    let depth = 0;
    let close = -1;
    for (let i = open; i < slice.length; i += 1) {
      if (slice[i] === '{') depth += 1;
      else if (slice[i] === '}' && --depth === 0) { close = i; break; }
    }
    block = close > open ? slice.slice(guardAt, close + 1) : '';
  }
  const statusReturns = (block.match(/if \(session\.status !== 'running'\) return;/g) || []).length;
  check(block.length > 0 && block.indexOf('await globalThis.FsbFastPath.beforeTurn(session') !== -1 && statusReturns === 1,
    'seam 1 guard shape: the session.fastMode block awaits beforeTurn and holds exactly one status return');
  check(block.length > 0 && /\}\s*$/.test(block) && block.lastIndexOf("if (session.status !== 'running') return;") > block.indexOf('await globalThis.FsbFastPath.beforeTurn(session'),
    'seam 1 guard shape: the status return comes after the await, inside the guarded block');
  const rest = block.length > 0 ? slice.replace(block, '') : slice;
  check(slice.length > 0 && !/\breturn\b/.test(rest) && !/\bawait\b/.test(rest) && rest.indexOf('session.status') === -1,
    'seam 1 guard shape: outside that block the slice has no return, no await and no session.status');
  check(/if \(_fastStep && _fastStep\.toolCall\) \{/.test(rest), 'seam 1 guard shape: the fast branch is a falsy test of _fastStep when the field is absent');
  check((agentLoopSource.match(/globalThis\.FsbFastPath\.beforeTurn\(session/g) || []).length === 1
    && (agentLoopSource.match(/globalThis\.FsbFastPath\.afterStep\(session/g) || []).length === 1,
  'seam 1 guard shape: one beforeTurn call and one afterStep call in agent-loop.js');
}

async function acceptedStepCases() {
  section('accepted step: one code-built click through the real tool loop (D-08, D-09, D-10, D-19)');
  const { h, decideRequests } = fastHarness({ harness: { providerScript: [LLM_CLICK, LLM_DONE, LLM_DONE_2] } });
  try {
    await h.step();
    const it1 = stepEvents(h.events, 1);
    check(contentActions(it1, 'getJevMenu').length === 0 && decideRequests.length === 0,
      'first-turn rule: iteration 1 requests no menu and makes no decide call');
    check(ofType(it1, 'provider').length === 1, 'iteration 1 is the LLM turn (one provider request)');
    const messagesAfter1 = h.session.messages.length;

    await h.step();
    const it2 = stepEvents(h.events, 2);
    check(ofType(it2, 'provider').length === 0, 'accepted step: iteration 2 makes no provider request');
    check(contentActions(it2, 'getJevMenu').length === 1 && decideRequests.length === 1,
      'accepted step: iteration 2 makes one menu request and one decide call');
    const menuMessage = contentActions(it2, 'getJevMenu')[0];
    check(menuMessage && menuMessage.options && menuMessage.options.frameId === 0, 'the menu request goes to frame 0');
    const actions = contentActions(it2, 'executeAction');
    check(actions.length === 1 && actions[0].message.tool === 'click', 'accepted step: one executeAction with tool "click"');
    const params = actions.length === 1 ? actions[0].message.params : {};
    check(params.jevHandle === 'j1' && params.jevGeneration === 'gen1abcd-1' && params.expectedRole === 'button' && params.expectedName === 'Next',
      'accepted step: params carry jevHandle, jevGeneration, expectedRole and expectedName');
    check(!('selector' in params) && !('text' in params) && !('value' in params),
      'accepted step: params carry no selector, text or value');
    const history = h.session.actionHistory;
    const last = history[history.length - 1];
    check(last && last.tool === 'click' && last.iteration === 2 && last.decisionSource === 'jev' && last.params && last.params.jevHandle === 'j1',
      'accepted step: the actionHistory event is tagged decisionSource "jev"');
    check(h.session.messages.length === messagesAfter1 && !h.session.messages.some((m) => m.role === 'tool' && /^jev_/.test(String(m.tool_call_id))),
      'accepted step: session.messages gains no tool message and no other entry for the fast step');
    check(ofType(it2, 'schedule').length === 1 && ofType(it2, 'schedule')[0].delayMs === 100, 'accepted step: iteration 2 schedules the next iteration normally');
    check(h.session.agentState.iterationCount === 2 && h.session.iterationCount === 2, 'the fast iteration counts toward the existing iteration count');
    check(h.session._metaAttempts && Object.keys(h.session._metaAttempts).indexOf('jev:/wizard/step-2:button:Next') !== -1,
      'the meta-attempt counter saw the fast click under jev:/wizard/step-2:button:Next');

    await h.step();
    const it3 = stepEvents(h.events, 3);
    const requests3 = ofType(it3, 'provider');
    check(decideRequests.length === 2 && contentActions(it3, 'getJevMenu').length === 1,
      'iteration 3 asks once more and the gateway answers none_of_the_above');
    check(contentActions(it3, 'executeAction').length === 0, 'iteration 3 takes no fast step');
    check(requests3.length === 1, 'iteration 3 runs the LLM');
    const body = requests3.length === 1 ? requests3[0].requestBody : { messages: [] };
    const handoffs = handoffMessages(body.messages);
    check(handoffs.length === 1, 'the LLM request holds exactly one user message starting with FAST MODE HAND-OFF');
    check(handoffs.length === 1 && handoffs[0].content.indexOf('SNAP-HANDOFF') !== -1 && /click button "Next" \(page text\)/.test(handoffs[0].content),
      'the hand-off names the click on "Next" and carries the fresh snapshot');
    check(contentActions(it3, 'getMarkdownSnapshot').length === 1, 'the hand-off fetched one snapshot');
    check(toolCallsPaired(body.messages), 'the LLM request has no unpaired tool call');
    check(h.session.status === 'completed', 'the LLM completes the task after the hand-off');

    // First-turn rule after a follow-up (D-09, F14): a new command and a
    // rebuilt agentState, as reactivateSession and hydrateAgentRunState do.
    h.session.status = 'running';
    h.session.commandCount = 2;
    h.session.task = 'Now open the summary';
    h.session.commands = (h.session.commands || []).concat(['Now open the summary']);
    h.session.agentState = {
      iterationCount: 0,
      completedIterations: 0,
      totalInputTokens: h.session.totalInputTokens || 0,
      totalOutputTokens: h.session.totalOutputTokens || 0,
      totalCost: h.session.totalCost || 0,
      startTime: Date.now(),
      lastDOMHash: null,
      consecutiveNoChangeCount: 0
    };
    const decidesBefore = decideRequests.length;
    await h.step();
    const it4 = stepEvents(h.events, 4);
    check(contentActions(it4, 'getJevMenu').length === 0 && decideRequests.length === decidesBefore && ofType(it4, 'provider').length === 1,
      'first-turn rule: the first iteration of a follow-up command requests no menu and runs the LLM');
  } finally {
    h.dispose();
  }

  section('accepted step: check_box reaches the content script as toggleCheckbox with checked:true');
  const box = fastHarness({ answers: [calibrated('check_box', 'Agree'), catchAll], harness: { providerScript: [LLM_CLICK, LLM_DONE] } });
  try {
    await box.h.step();
    await box.h.step();
    const it2 = stepEvents(box.h.events, 2);
    const actions = contentActions(it2, 'executeAction');
    check(ofType(it2, 'provider').length === 0 && actions.length === 1 && actions[0].message.tool === 'toggleCheckbox',
      'check_box: one executeAction with the content verb "toggleCheckbox" and no provider request');
    const params = actions.length === 1 ? actions[0].message.params : {};
    check(params.checked === true && params.jevHandle === 'j2' && params.expectedRole === 'checkbox' && params.expectedName === 'Agree',
      'check_box: params.checked is true and the handle is the Agree checkbox');
  } finally {
    box.h.dispose();
  }
}

async function toolDispatchCase() {
  section('TOOL_DISPATCH on a fast iteration keeps previousStepName LLM_TURN (D-08 choice)');
  const transitions = [];
  const { h } = fastHarness({ harness: { providerScript: [LLM_CLICK, LLM_DONE] } });
  globalThis.sendLatticeStepTransition = function (payload) { transitions.push(JSON.parse(JSON.stringify(payload))); };
  try {
    await h.step();
    await h.step();
    const it2 = transitions.filter((t) => t.stepIndex === 2);
    check(it2.length === 1 && it2[0].stepName === 'TOOL_DISPATCH' && it2[0].previousStepName === 'LLM_TURN',
      'fast TOOL_DISPATCH: iteration 2 emits exactly one TOOL_DISPATCH with previousStepName LLM_TURN');
    check(!it2.some((t) => t.stepName === 'LLM_TURN'), 'fast TOOL_DISPATCH: no LLM_TURN is emitted for the fast iteration');
    const it1 = transitions.filter((t) => t.stepIndex === 1);
    check(it1.length === 2 && it1[0].stepName === 'LLM_TURN' && it1[1].stepName === 'TOOL_DISPATCH', 'the LLM iteration still emits LLM_TURN then TOOL_DISPATCH');
  } finally {
    delete globalThis.sendLatticeStepTransition;
    h.dispose();
  }
  check(typeof globalThis.sendLatticeStepTransition === 'undefined', 'the transition recorder is removed after the case');
}

async function permissionDenialCase() {
  section('permission denial: the real permission hook refuses the fast click (D-19)');
  const results = [];
  const { h, decideRequests } = fastHarness({ harness: { providerScript: [LLM_SNAPSHOT, LLM_DONE], permissionDenies: ['click'] } });
  const real = h.fastPath;
  globalThis.FsbFastPath = Object.assign({}, real, {
    afterStep(session, step, toolResults) {
      results.push(JSON.parse(JSON.stringify(toolResults)));
      return real.afterStep(session, step, toolResults);
    }
  });
  try {
    await h.step();
    await h.step();
    const it2 = stepEvents(h.events, 2);
    check(decideRequests.length === 1 && ofType(it2, 'provider').length === 0, 'the fast click was accepted by the decision and no provider request ran');
    check(contentActions(it2, 'executeAction').length === 0, 'denial: no executeAction is sent for the denied fast call');
    const fastResult = results.length === 1 && results[0].length === 1 ? results[0][0].result : null;
    check(fastResult && JSON.stringify(fastResult) === JSON.stringify({
      success: false, hadEffect: false, error: 'Tool "click" is not permitted for this origin', navigationTriggered: false, result: null
    }), 'denial: the fast call result is the agent-loop denial shape with the production text');
    await h.step();
    const it3 = stepEvents(h.events, 3);
    const requests3 = ofType(it3, 'provider');
    const handoffs = requests3.length === 1 ? handoffMessages(requests3[0].requestBody.messages) : [];
    check(requests3.length === 1 && handoffs.length === 1, 'denial: the next iteration runs the LLM with one hand-off');
    check(handoffs.length === 1 && handoffs[0].content.indexOf('not permitted, so nothing ran') !== -1 && handoffs[0].content.indexOf('not run: not permitted') !== -1,
      'denial: the hand-off says the step was not permitted and nothing ran');
    check(contentActions(it3, 'getJevMenu').length === 0, 'denial: the LLM takes that turn without another fast attempt');
  } finally {
    h.dispose();
  }
}

async function runTaskCase() {
  section('run_task: fastMode {enabled:false, source:"mcp"} stays on the golden path (D-03)');
  const decides = [];
  const { record, harness } = await H.runGoldenScenario({
    loadFastPath: true,
    storage: { fsbJevFastModeEnabled: true },
    deps: createBackgroundDeps(),
    jevResponder: (request) => { decides.push(request); return catchAll(request); },
    sessionPatch: { fastMode: { enabled: false, stored: true, source: 'mcp' } }
  });
  check(harness.session.fastMode && harness.session.fastMode.enabled === false, 'the run_task session carries enabled:false');
  check(matchesGolden(record, 'run_task'), 'run_task: content messages, provider requests, tool calls and session.messages equal the golden');
  check(decides.length === 0 && !harness.contentMessages.some((m) => m.message && m.message.action === 'getJevMenu'),
    'run_task: no menu request and no decide call');
}

/** A harness whose FsbFastPath is a stub; returns {h}. */
function stubbedHarness(stub, script) {
  const h = H.createHarness({
    loadFastPath: true,
    sessionPatch: { fastMode: Object.assign({}, FAST_FIELD) },
    providerScript: script || [LLM_CLICK, LLM_DONE]
  });
  globalThis.FsbFastPath = stub;
  return h;
}

async function containmentCases() {
  section('containment: fast-path errors never reach the API-error path (F13); a stop ends the iteration (F21)');
  const noop = () => {};
  const variants = [
    ['throws', { beforeTurn() { throw new Error('beforeTurn threw'); }, afterStep: noop, observeTools: noop }],
    ['rejects', { beforeTurn() { return Promise.reject(new Error('beforeTurn rejected')); }, afterStep: noop, observeTools: noop }],
    ['observeTools throws', { beforeTurn() { return Promise.resolve({ decline: 'first_llm_turn' }); }, afterStep: noop, observeTools() { throw new Error('observe threw'); } }]
  ];
  for (const [label, stub] of variants) {
    const h = stubbedHarness(stub);
    try {
      await h.step();
      const it1 = stepEvents(h.events, 1);
      const schedules = ofType(it1, 'schedule');
      check(ofType(it1, 'provider').length === 1 && contentActions(it1, 'executeAction').length === 1
        && schedules.length === 1 && schedules[0].delayMs === 100 && h.session.status === 'running'
        && h.session.agentState.iterationCount === 1,
      'containment: a beforeTurn/observeTools that ' + label + ' leaves the iteration to the LLM with a normal 100 ms schedule');
    } finally {
      h.dispose();
    }
  }

  const afterThrows = stubbedHarness({
    beforeTurn() { return Promise.resolve({ toolCall: { id: 'jev_1_1', name: 'scroll', args: { direction: 'down' }, source: 'jev', pagePath: '/x' }, step: { callId: 'jev_1_1' } }); },
    afterStep() { throw new Error('afterStep threw'); },
    observeTools: noop
  });
  try {
    await afterThrows.step();
    const it1 = stepEvents(afterThrows.events, 1);
    const schedules = ofType(it1, 'schedule');
    check(ofType(it1, 'provider').length === 0 && schedules.length === 1 && schedules[0].delayMs === 100 && afterThrows.session.status === 'running',
      'containment: an afterStep that throws leaves the fast iteration to finish and schedule normally');
    check(!afterThrows.session.messages.some((m) => m.role === 'tool'), 'containment: the fast step still adds no tool message');
  } finally {
    afterThrows.dispose();
  }

  let stopSession = null;
  const stopped = stubbedHarness({
    beforeTurn(session) {
      stopSession = session;
      session.status = 'stopped';
      return Promise.resolve({ decline: 'stopped' });
    },
    afterStep: noop,
    observeTools: noop
  });
  try {
    await stopped.step();
    const it1 = stepEvents(stopped.events, 1);
    check(stopSession === stopped.session && ofType(it1, 'provider').length === 0 && ofType(it1, 'schedule').length === 0
      && ofType(it1, 'persist').length === 0 && contentActions(it1, 'executeAction').length === 0,
    'stop during the decision: the iteration ends with no provider call, no action, no persist and no schedule');
  } finally {
    stopped.dispose();
  }
}

// ---------------------------------------------------------------------------
// Plan 68-07 Task 1: latches, budgets, completion and stuck gates, and the
// existing breakers, all through the real runAgentIteration (D-12, D-16,
// D-17, D-18, F1; AUTO-03-d, AUTO-04-a..c, AUTO-05-b).
// ---------------------------------------------------------------------------

const TERMINAL_TOOLS = ['complete_task', 'partial_task', 'fail_task'];
// Every fast call a loop case executed (actionHistory decisionSource 'jev').
const executedFastTools = [];
// A bench goal holding a run token: the 67-01 high-entropy rule refuses it locally (F5).
const BENCH_GOAL = 'Open http://127.0.0.1:53211/r/Ab3dEf9hIj2kLm5nOp8qRs/fixtures/checklist/index.html. Tick Alpha.';

/** The fast-path module (already loaded by the harness; require is cached). */
function fastPathApi() {
  return require('../extension/ai/jev-fast-path.js');
}

function itemEntries(count) {
  const list = [];
  for (let i = 1; i <= count; i += 1) list.push(entry('j' + i, { label: 'Item ' + i }));
  return list;
}
const ITEM_ENTRIES = itemEntries(20);
const NEXT_ENTRIES = [entry('j1', { label: 'Next' }), entry('j2', { label: 'Back' })];

/** A calibrated answer: op on the control labelled label, plus extra picks (completion, stuck, ...). */
function calibratedPick(op, label, extra) {
  return (request) => ({ body: gateway.calibratedBody(request, Object.assign({
    operation: { choice: op },
    target: { choice: idByLabel(request, label) }
  }, extra || {})) });
}

/** The i-th decide (0-based) clicks "Item <i+1>", so every fast step hits a different control. */
function clickNthItem(request, info, index) {
  return calibratedPick('click', 'Item ' + (index + 1))(request);
}

/** A calibrated answer whose operation confidence is below its cut (operation_below_threshold). */
function belowThresholdOp(request) {
  return { body: gateway.calibratedBody(request, {
    operation: { choice: 'click', confidence: 0.5 },
    target: { choice: request.elements.length > 0 ? request.elements[0].id : gateway.CATCH_ALL }
  }) };
}

/** LLM turns that only read the page: get_page_snapshot, a fresh call id each turn. */
function llmSnapshotScript() {
  return (index) => H.openAiToolResponse('resp_snap_' + index, [{ id: 'call_snap_' + index, name: 'get_page_snapshot', args: {} }]);
}

/**
 * A fast-mode run on the real loop. opts: answers (scriptedGateway), content
 * (signatureMenuContent options; ITEM_ENTRIES by default), clock (a fake
 * clock for the deps and the client), fast (false: no session.fastMode, the
 * switch-off session), maxIterations (40), task, providerScript,
 * providerKey, sessionPatch.
 */
function loopRun(opts) {
  const o = opts || {};
  const content = H.signatureMenuContent(Object.assign({ entries: ITEM_ENTRIES }, o.content || {}));
  const gw = H.scriptedGateway(o.answers || [catchAll]);
  const deps = createBackgroundDeps();
  if (o.clock) deps.now = o.clock.now;
  const rec = H.recordingJevClient(gw.responder, { now: deps.now });
  const sessionPatch = Object.assign({ maxIterations: o.maxIterations || 40 }, o.sessionPatch || {});
  if (o.fast !== false) sessionPatch.fastMode = Object.assign({}, FAST_FIELD);
  const harnessOptions = {
    loadFastPath: true,
    storage: { fsbJevFastModeEnabled: o.fast !== false },
    sessionPatch,
    deps,
    jevClient: rec.client,
    contentResponder: content.respond,
    providerScript: o.providerScript || llmSnapshotScript()
  };
  if (o.task) harnessOptions.task = o.task;
  if (o.providerKey) harnessOptions.providerKey = o.providerKey;
  const h = H.createHarness(harnessOptions);
  return { h, content, gw, rec, steps: [] };
}

/** Run n iterations, recording per iteration what the loop and the fast path did. */
async function runSteps(run, n) {
  for (let i = 0; i < n; i += 1) {
    const decidesBefore = run.rec.decides.length;
    const callsBefore = run.gw.requests.length;
    await run.h.step();
    const index = run.h.stepsRun;
    const ev = stepEvents(run.h.events, index);
    const actions = contentActions(ev, 'executeAction');
    const jf = run.h.session.agentState ? run.h.session.agentState.jevFast : null;
    run.steps.push({
      index,
      providerEvents: ofType(ev, 'provider'),
      provider: ofType(ev, 'provider').length,
      menus: contentActions(ev, 'getJevMenu').length,
      snapshots: contentActions(ev, 'getMarkdownSnapshot').length,
      decides: run.rec.decides.length - decidesBefore,
      gatewayCalls: run.gw.requests.length - callsBefore,
      fast: actions.filter((e) => e.message.params && e.message.params.jevHandle).length,
      actions: actions.length,
      schedules: ofType(ev, 'schedule').length,
      status: run.h.session.status,
      latched: jf ? jf.latched : null,
      consecutiveEscalations: jf ? jf.consecutiveEscalations : null,
      jevMs: jf ? jf.jevMs : null
    });
  }
  return run.steps;
}

function total(run, key) {
  return run.steps.reduce((sum, s) => sum + s[key], 0);
}

function iterationsWhere(run, key) {
  return run.steps.filter((s) => s[key] > 0).map((s) => s.index);
}

/** The hand-off messages in the (openai-format) LLM request of one recorded step. */
function handoffsIn(step) {
  const body = step && step.providerEvents.length === 1 ? step.providerEvents[0].requestBody : null;
  return body && Array.isArray(body.messages) ? handoffMessages(body.messages) : [];
}

function jevFastOf(run) {
  return (run.h.session.agentState && run.h.session.agentState.jevFast) || {};
}

function fastStateOf(run) {
  return run.h.session._fastPath || {};
}

/** A follow-up command on the same session, as reactivateSession and hydrateAgentRunState leave it. */
function startFollowUp(h, task) {
  h.session.status = 'running';
  h.session.commandCount = (h.session.commandCount || 1) + 1;
  h.session.task = task;
  h.session.commands = (h.session.commands || []).concat([task]);
  h.session.agentState = {
    iterationCount: 0,
    completedIterations: 0,
    totalInputTokens: h.session.totalInputTokens || 0,
    totalOutputTokens: h.session.totalOutputTokens || 0,
    totalCost: h.session.totalCost || 0,
    startTime: Date.now(),
    lastDOMHash: null,
    consecutiveNoChangeCount: 0
  };
}

/** Collect the run's executed fast calls, then restore the globals. */
function finish(run) {
  for (const event of run.h.session.actionHistory || []) {
    if (event && event.decisionSource === 'jev') executedFastTools.push(event.tool);
  }
  run.h.dispose();
}

/** Still running, and fast mode never applied a terminal outcome. */
function stillRunning(run) {
  return run.h.session.status === 'running' && run.h.session.outcome === undefined && run.h.session.outcomeDetails === undefined;
}

function sixTurnScript() {
  return [
    H.openAiToolResponse('resp_u1', [{ id: 'call_u1', name: 'click', args: { selector: '#a' } }]),
    H.openAiToolResponse('resp_u2', [{ id: 'call_u2', name: 'get_page_snapshot', args: {} }]),
    H.openAiToolResponse('resp_u3', [{ id: 'call_u3', name: 'click', args: { selector: '#b' } }]),
    H.openAiToolResponse('resp_u4', [{ id: 'call_u4', name: 'get_page_snapshot', args: {} }]),
    H.openAiToolResponse('resp_u5', [{ id: 'call_u5', name: 'click', args: { selector: '#c' } }]),
    H.openAiToolResponse('resp_u6', [{ id: 'call_u6', name: 'get_page_snapshot', args: {} }])
  ];
}

async function uncalibratedLatchCases() {
  section('latches and budgets: the uncalibrated latch through the loop (D-16, AUTO-03-d)');
  const off = loopRun({ fast: false, providerScript: sixTurnScript() });
  try {
    await runSteps(off, 6);
  } finally {
    finish(off);
  }
  check(off.steps.every((s) => s.provider === 1 && s.menus === 0 && s.decides === 0) && stillRunning(off),
    'uncalibrated latch: the switch-off reference run is six LLM turns with no menu and no decide');

  const bodies = [['uncalibrated', gateway.uncalibratedBody], ['snapshot_changed', gateway.snapshotChangedBody]];
  for (const [label, makeBody] of bodies) {
    const on = loopRun({ providerScript: sixTurnScript(), answers: [(request) => ({ body: makeBody(request) })] });
    try {
      await runSteps(on, 6);
      check(total(on, 'menus') === 1 && on.steps[1].menus === 1 && total(on, 'decides') === 1 && on.steps[1].decides === 1 && on.gw.requests.length === 1,
        'uncalibrated latch (' + label + '): exactly one getJevMenu and one decide in the whole session, both in iteration 2');
      check(on.steps.every((s) => s.provider === 1 && s.fast === 0),
        'uncalibrated latch (' + label + '): every iteration, iteration 2 included, runs the LLM and no fast step acts');
      check(on.steps.slice(2).every((s) => s.menus === 0 && s.decides === 0 && s.snapshots === (off.steps[s.index - 1].snapshots)),
        'uncalibrated latch (' + label + '): iterations 3-6 send no getJevMenu, make no decide and fetch no extra snapshot');
      check(handoffMessages(on.h.session.messages).length === 0
        && util.isDeepStrictEqual(on.h.finalState().messages, off.h.finalState().messages),
      'uncalibrated latch (' + label + '): fast mode added nothing to session.messages (it equals the switch-off run)');
      let sameBodies = true;
      for (let k = 2; k < 6; k += 1) {
        if (!util.isDeepStrictEqual(on.steps[k].providerEvents, off.steps[k].providerEvents)) sameBodies = false;
      }
      check(sameBodies, 'uncalibrated latch (' + label + '): the provider request bodies of iterations 3-6 equal the switch-off run');
      check(util.isDeepStrictEqual(on.steps[1].providerEvents, off.steps[1].providerEvents),
        'uncalibrated latch (' + label + '): iteration 2\'s LLM request (after the declined attempt) also equals the switch-off run');
      check(fastStateOf(on).off === true && fastStateOf(on).offReason === 'not_calibrated' && stillRunning(on),
        'uncalibrated latch (' + label + '): the session latch reads not_calibrated and the session keeps running');
    } finally {
      finish(on);
    }
  }
}

async function fallbackClassCases() {
  section('latches and budgets: fallback classes through the loop (D-16, AUTO-05-b)');
  const sessionClass = [
    ['disabled', () => ({ body: gateway.fallbackBody('disabled') }), 'disabled'],
    ['invalid_request (a 404 with no body)', () => ({ status: 404, text: '' }), 'invalid_request']
  ];
  for (const [label, answer, reason] of sessionClass) {
    const run = loopRun({ answers: [answer] });
    try {
      await runSteps(run, 4);
      check(run.gw.requests.length === 1 && total(run, 'decides') === 1 && run.steps[1].decides === 1 && run.steps[1].provider === 1,
        'fallback ' + label + ': one Jev call in iteration 2, and that iteration runs the LLM');
      check(run.steps.slice(2).every((s) => s.menus === 0 && s.decides === 0 && s.provider === 1),
        'fallback ' + label + ': later iterations send no menu request and make no decide');
      check(fastStateOf(run).off === true && fastStateOf(run).offReason === reason, 'fallback ' + label + ': the session latch names ' + reason);
      startFollowUp(run.h, 'Now open the summary');
      await runSteps(run, 3);
      check(run.steps.slice(4).every((s) => s.menus === 0 && s.decides === 0 && s.provider === 1) && run.gw.requests.length === 1,
        'fallback ' + label + ': a follow-up command in the same session still makes no menu request and no decide (session latch: one call in the session)');
      check(stillRunning(run), 'fallback ' + label + ': the session keeps running with no outcome from fast mode');
    } finally {
      finish(run);
    }
  }

  const sens = loopRun({ task: BENCH_GOAL });
  try {
    await runSteps(sens, 4);
    check(sens.steps[1].menus === 1 && total(sens, 'decides') === 0 && sens.gw.requests.length === 0 && sens.steps[1].provider === 1,
      'fallback sensitive_goal: a goal holding a run token is refused locally (one menu, zero decide calls) and the LLM runs');
    check(jevFastOf(sens).latched === 'sensitive_goal' && fastStateOf(sens).off === false,
      'fallback sensitive_goal: it latches the command, not the session');
    check(sens.steps.slice(2).every((s) => s.menus === 0 && s.decides === 0), 'fallback sensitive_goal: the rest of the command sends no menu request');
    startFollowUp(sens.h, 'Now open the summary page');
    await runSteps(sens, 2);
    check(sens.steps[4].menus === 0 && sens.steps[5].menus === 1 && sens.steps[5].decides === 1,
      'fallback sensitive_goal: the next command, with a clean goal, asks Jev again after its first LLM turn');
  } finally {
    finish(sens);
  }

  const timeoutRun = loopRun({
    content: { signature: 'S-fixed' },
    answers: [() => ({ body: gateway.fallbackBody('timeout', 504) }), clickNthItem]
  });
  try {
    await runSteps(timeoutRun, 3);
    check(timeoutRun.steps[1].decides === 1 && timeoutRun.steps[1].provider === 1 && timeoutRun.steps[1].fast === 0,
      'fallback timeout: iteration 2 escalates that iteration only and runs the LLM');
    check(timeoutRun.steps[2].menus === 1 && timeoutRun.steps[2].decides === 1 && timeoutRun.steps[2].fast === 1 && timeoutRun.steps[2].provider === 0,
      'fallback timeout: after the next LLM turn fast mode asks again on the same page state and acts (a fallback is not an answer)');
    check(!jevFastOf(timeoutRun).latched && fastStateOf(timeoutRun).off === false && stillRunning(timeoutRun),
      'fallback timeout: no latch is left behind');
  } finally {
    finish(timeoutRun);
  }

  const busy = loopRun({ answers: [() => ({ body: gateway.fallbackBody('busy') })] });
  try {
    await runSteps(busy, 6);
    check(busy.steps.slice(1, 4).every((s) => s.decides === 1 && s.provider === 1 && s.fast === 0),
      'escalation latch: iterations 2-4 each make one decide, get a transient fallback and run the LLM');
    check(busy.steps.slice(4).every((s) => s.menus === 0 && s.decides === 0 && s.provider === 1) && total(busy, 'decides') === 3,
      'escalation latch: three consecutive transient fallbacks latch the command; there is no fourth decide');
    check(jevFastOf(busy).latched === 'escalation_latch' && fastStateOf(busy).off === false && stillRunning(busy),
      'escalation latch: the command latch reads escalation_latch, the session is not latched and keeps running');
  } finally {
    finish(busy);
  }
}

async function budgetCases() {
  section('latches and budgets: the four per-command budgets switch to LLM-only and never end the task (D-12, AUTO-04-a)');
  const FAST = fastPathApi().constants;
  check(FAST.FAST_MAX_CONSECUTIVE === 3 && FAST.FAST_MAX_STEPS === 12 && FAST.FAST_MAX_CALLS === 16 && FAST.FAST_WALL_BUDGET_MS === 20000,
    'the budgets under test are FAST_MAX_CONSECUTIVE 3, FAST_MAX_STEPS 12, FAST_MAX_CALLS 16 and FAST_WALL_BUDGET_MS 20000');

  const cap = loopRun({ answers: [clickNthItem] });
  try {
    await runSteps(cap, 6);
    check(cap.steps.slice(1, 4).every((s) => s.fast === 1 && s.provider === 0),
      'consecutive cap: iterations 2-4 are three effective fast steps with no provider request');
    check(cap.steps[4].provider === 1 && cap.steps[4].menus === 0 && cap.steps[4].decides === 0 && cap.steps[4].fast === 0,
      'consecutive cap: FAST_MAX_CONSECUTIVE forces iteration 5 onto the LLM with no menu and no decide');
    const handoffs = handoffsIn(cap.steps[4]);
    check(handoffs.length === 1 && handoffs[0].content.indexOf('Fast mode took 3 steps') !== -1
      && handoffs[0].content.indexOf(fastPathApi().describeEscalation('consecutive_cap')) !== -1,
    'consecutive cap: that LLM request carries one hand-off listing the 3 steps and the consecutive-cap reason');
    check(cap.steps[5].fast === 1 && stillRunning(cap), 'consecutive cap: the command is not latched; iteration 6 takes a fast step again');
  } finally {
    finish(cap);
  }

  const stepBudget = loopRun({ answers: [clickNthItem] });
  try {
    await runSteps(stepBudget, 19);
    const fastIterations = iterationsWhere(stepBudget, 'fast');
    check(total(stepBudget, 'fast') === 12 && util.isDeepStrictEqual(fastIterations, [2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15, 16]),
      'step budget: twelve effective fast steps run, three at a time between LLM turns (' + fastIterations.join(',') + ')');
    check(stepBudget.steps.slice(16).every((s) => s.fast === 0 && s.provider === 1) && total(stepBudget, 'decides') === 12,
      'step budget: the twelfth fast step is the last one in the command; every later iteration runs the LLM');
    check(stepBudget.steps[17].menus === 0 && stepBudget.steps[17].decides === 0 && jevFastOf(stepBudget).latched === 'step_budget',
      'step budget: iteration 18 latches the command step_budget before any menu or decide');
    check(stillRunning(stepBudget), 'step budget: the session keeps running; fast mode applied no terminal outcome');
  } finally {
    finish(stepBudget);
  }

  const callBudget = loopRun({ answers: [(request, info, index) => (index % 2 === 0 ? clickNthItem(request, info, index) : belowThresholdOp(request))] });
  try {
    await runSteps(callBudget, 18);
    const decideIterations = iterationsWhere(callBudget, 'decides');
    check(total(callBudget, 'decides') === 16 && decideIterations[decideIterations.length - 1] === 17 && decideIterations.length === 16,
      'call budget: alternating an acted step and a below-threshold escalation, the sixteenth decide (iteration 17) is the last one in the command');
    check(total(callBudget, 'fast') === 8 && callBudget.steps.filter((s) => s.decides === 1 && s.fast === 0).every((s) => s.provider === 1),
      'call budget: eight steps acted and every escalated iteration ran the LLM');
    check(callBudget.steps[17].menus === 0 && callBudget.steps[17].decides === 0 && callBudget.steps[17].provider === 1
      && jevFastOf(callBudget).latched === 'call_budget',
    'call budget: iteration 18 latches the command call_budget and runs the LLM');
    check(stillRunning(callBudget), 'call budget: the session keeps running; fast mode applied no terminal outcome');
  } finally {
    finish(callBudget);
  }

  // Time budget: the fake clock moves 300 ms per menu and 2 400 ms per decide;
  // a decide whose deadline is shorter takes the deadline and times out
  // through the real client (its held timer fires), as a slow gateway would.
  const clock = H.makeFakeClock(0);
  const ref = {};
  const timeBudget = loopRun({
    clock,
    content: { onMenu: () => clock.advance(300) },
    answers: [(request, info, index) => {
      const deadline = ref.run.rec.timers.lastDelay();
      if (deadline < 2400) {
        clock.advance(deadline);
        ref.run.rec.timers.fireAll();
        return new Promise(() => {});
      }
      clock.advance(2400);
      return clickNthItem(request, info, index);
    }]
  });
  ref.run = timeBudget;
  try {
    await runSteps(timeBudget, 13);
    const decides = timeBudget.rec.decides;
    const limit = FAST.FAST_WALL_BUDGET_MS;
    check(decides.length === 8 && decides.every((d) => typeof d.timeoutMs === 'number' && d.timeoutMs <= Math.min(2500, limit - d.at)),
      'time budget: every decide receives timeoutMs <= min(2500, remaining) (' + decides.map((d) => d.timeoutMs + '@' + d.at).join(', ') + ')');
    check(util.isDeepStrictEqual(decides.map((d) => d.timeoutMs), [2500, 2500, 2500, 2500, 2500, 2500, 2500, 800]),
      'time budget: the eighth decide gets only the 800 ms left (19 200 ms used)');
    check(jevFastOf(timeBudget).latched === 'time_budget' && jevFastOf(timeBudget).jevMs === limit && clock.t === limit,
      'time budget: the command latches time_budget with exactly 20 000 ms used, never more');
    const latchAt = timeBudget.steps.findIndex((s) => s.latched === 'time_budget');
    check(latchAt >= 0 && timeBudget.steps.slice(latchAt).every((s) => s.menus === 0 && s.decides === 0 && s.provider === 1),
      'time budget: from the latch on, every iteration runs the LLM with no menu and no decide');
    check(timeBudget.steps[10].decides === 1 && timeBudget.steps[10].fast === 0 && timeBudget.steps[10].provider === 1,
      'time budget: the cut-short eighth decide escalates and that iteration runs the LLM');
    check(stillRunning(timeBudget), 'time budget: the session keeps running; fast mode applied no terminal outcome');
  } finally {
    finish(timeBudget);
  }
}

async function completionStuckCases() {
  section('latches and budgets: completion and stuck gates through the loop (D-17, AUTO-04-c)');
  const low = loopRun({ answers: [
    calibratedPick('click', 'Item 1', { completion: { p: 0.05, threshold: 0.2 } }),
    calibratedPick('click', 'Item 2', { completion: { p: 0.05, threshold: 0.2 } })
  ] });
  try {
    await runSteps(low, 3);
    check(low.steps[1].fast === 1 && low.steps[2].fast === 1 && low.steps[2].provider === 0,
      'completion: a calibrated completion p below the cut (0.05 <= 0.2) lets the fast step act, and the next one too');
  } finally {
    finish(low);
  }

  const high = loopRun({ answers: [
    calibratedPick('click', 'Item 1'),
    calibratedPick('click', 'Item 2', { completion: { p: 0.6, threshold: 0.2 } })
  ] });
  try {
    await runSteps(high, 3);
    check(high.steps[1].fast === 1 && high.steps[2].decides === 1 && high.steps[2].fast === 0 && high.steps[2].provider === 1,
      'completion: a calibrated completion p above the cut (not accepted) hands iteration 3 to the LLM with no fast step');
    const handoffs = handoffsIn(high.steps[2]);
    check(handoffs.length === 1 && handoffs[0].content.indexOf(fastPathApi().describeEscalation('completion_unconfirmed')) !== -1,
      'completion: the hand-off asks the LLM to check whether the goal is already met');
    check(stillRunning(high), 'completion: fast mode never ends the task itself');
  } finally {
    finish(high);
  }

  const notAFit = loopRun({ answers: [(request, info, index) => calibratedPick('click', 'Item ' + (index + 1), { completion: { threshold: null } })(request)] });
  try {
    await runSteps(notAFit, 5);
    check(notAFit.steps.slice(1, 4).every((s) => s.fast === 1 && s.provider === 0),
      'completion threshold_null: with operation and target accepted, the fast steps act');
    check(notAFit.steps[4].provider === 1 && notAFit.steps[4].menus === 0 && notAFit.steps[4].decides === 0,
      'completion threshold_null: the consecutive cap still forces iteration 5 onto the LLM');
  } finally {
    finish(notAFit);
  }

  const stuck = loopRun({ answers: [
    calibratedPick('click', 'Item 1'),
    calibratedPick('click', 'Item 2', { stuck: { p: 0.9, threshold: 0.8 } })
  ] });
  try {
    await runSteps(stuck, 3);
    check(stuck.steps[1].fast === 1 && stuck.steps[2].decides === 1 && stuck.steps[2].fast === 0 && stuck.steps[2].provider === 1,
      'stuck: a calibrated stuck p above its cut (0.9 >= 0.8) hands iteration 3 to the LLM with no fast step');
    const handoffs = handoffsIn(stuck.steps[2]);
    check(handoffs.length === 1 && handoffs[0].content.indexOf(fastPathApi().describeEscalation('jev_stuck')) !== -1,
      'stuck: the hand-off names the stuck signal');
    check(stillRunning(stuck), 'stuck: the session keeps running');
  } finally {
    finish(stuck);
  }
}

async function noProgressCases() {
  section('latches and budgets: the D-17 no-progress latch through the loop (sync issue 4)');
  const sameSignature = [
    ['an unconfirmed click', () => ({ success: true })],
    ['a click with verification.verified true', () => ({ success: true, verification: { verified: true, changes: ['content'], confidence: 'high' } })]
  ];
  for (const [label, action] of sameSignature) {
    const run = loopRun({ content: { entries: NEXT_ENTRIES, signature: 'S-same', action }, answers: [calibratedPick('click', 'Next'), catchAll] });
    try {
      await runSteps(run, 4);
      check(run.steps[1].fast === 1 && run.steps[1].provider === 0, 'no progress: iteration 2 takes ' + label + ' on "Next"');
      check(run.steps[2].menus === 1 && run.steps[2].decides === 0 && run.steps[2].provider === 1 && jevFastOf(run).latched === 'no_progress',
        'no progress: ' + label + ' followed by a menu with the same url and signature latches the command before the next decide');
      const handoffs = handoffsIn(run.steps[2]);
      check(handoffs.length === 1 && handoffs[0].content.indexOf(fastPathApi().describeEscalation('no_progress')) !== -1,
        'no progress: the next LLM request carries one hand-off with the no-progress hint (' + label + ')');
      check(run.steps[3].menus === 0 && run.steps[3].decides === 0 && total(run, 'decides') === 1 && stillRunning(run),
        'no progress: the command stays latched and the session keeps running (' + label + ')');
    } finally {
      finish(run);
    }
  }

  const moving = loopRun({ content: { entries: NEXT_ENTRIES, signature: 'action' }, answers: [calibratedPick('click', 'Next'), catchAll] });
  try {
    await runSteps(moving, 3);
    check(moving.steps[1].fast === 1 && moving.steps[2].decides === 1 && jevFastOf(moving).latched !== 'no_progress',
      'no progress: a verified click that changes the signature does not latch (the next iteration makes its decide)');
  } finally {
    finish(moving);
  }

  const twice = loopRun({
    content: { entries: NEXT_ENTRIES, signature: 'request', action: () => ({ success: true }) },
    answers: [calibratedPick('click', 'Next'), calibratedPick('click', 'Next'), catchAll]
  });
  try {
    await runSteps(twice, 4);
    check(twice.steps[1].fast === 1 && twice.steps[2].fast === 1, 'no progress: iterations 2 and 3 each click "Next" with no observed effect');
    check(twice.steps[3].menus === 1 && twice.steps[3].decides === 0 && twice.steps[3].provider === 1 && jevFastOf(twice).latched === 'no_progress',
      'no progress: two no-effect clicks on the same role and label latch even though a title counter changed the signature');
  } finally {
    finish(twice);
  }
}

async function sameStateCases() {
  section('latches and budgets: never re-roll; one decide per page state (D-18, AUTO-05-a)');
  const variants = [
    ['operation below_threshold', belowThresholdOp],
    ['target catch_all', (request) => ({ body: gateway.calibratedBody(request, { operation: { choice: 'click' }, target: { choice: gateway.CATCH_ALL } }) })],
    ['target threshold_null', (request) => ({ body: gateway.calibratedBody(request, { operation: { choice: 'click' }, target: { choice: idByLabel(request, 'Next'), threshold: null } }) })]
  ];
  for (const [label, first] of variants) {
    const signature = { value: 'S' };
    const run = loopRun({ content: { entries: NEXT_ENTRIES, signature: () => signature.value }, answers: [first, catchAll] });
    try {
      await runSteps(run, 2);
      const log2 = (run.h.session.toolCallLog || []).filter((e) => e.iteration === 2).map((e) => e.tool);
      check(run.steps[1].decides === 1 && run.steps[1].fast === 0 && run.steps[1].provider === 1 && util.isDeepStrictEqual(log2, ['get_page_snapshot']),
        'same state (' + label + '): iteration 2 escalates on menu (U, S) and the LLM\'s turn is only get_page_snapshot');
      await runSteps(run, 1);
      const jf = jevFastOf(run);
      check(run.steps[2].menus === 1 && total(run, 'decides') === 1 && run.steps[2].provider === 1 && run.steps[2].fast === 0,
        'same state (' + label + '): iteration 3 sees the same U and S, makes no second decide and runs the LLM');
      check(jf.consecutiveEscalations === 1 && !jf.latched, 'same state (' + label + '): the decline is not an escalation (consecutiveEscalations 1) and the command is not latched');
      signature.value = 'S2';
      await runSteps(run, 1);
      check(run.steps[3].decides === 1 && total(run, 'decides') === 2, 'same state (' + label + '): a changed signature in iteration 4 makes the second decide');
    } finally {
      finish(run);
    }
  }
}

async function breakerCases() {
  section('latches and budgets: the existing breakers count and stop fast steps (D-12, F1, AUTO-04-b)');
  // One harness at a time: createHarness installs its own chrome and timer globals.
  for (const limit of [4, 5]) {
    const offRun = loopRun({ fast: false, maxIterations: limit });
    try {
      await runSteps(offRun, limit);
    } finally {
      finish(offRun);
    }
    const fastRun = loopRun({ maxIterations: limit, answers: [clickNthItem] });
    try {
      await runSteps(fastRun, limit);
      const fastIterations = iterationsWhere(fastRun, 'fast');
      const expected = [];
      for (let i = 2; i < limit; i += 1) expected.push(i);
      const last = fastRun.steps[limit - 1];
      check(util.isDeepStrictEqual(fastIterations, expected) && last.provider === 0 && last.menus === 0 && last.decides === 0 && last.schedules === 0,
        'maxIterations: with maxIterations ' + limit + ' and fast steps in iterations ' + expected.join('-') + ', iteration ' + limit + ' stops before any menu or provider call');
      const fastDetails = fastRun.h.session.outcomeDetails || {};
      const offDetails = offRun.h.session.outcomeDetails || {};
      check(fastRun.h.session.status === 'stopped' && fastDetails.reason === 'iteration_limit_exceeded'
        && offRun.h.session.status === 'stopped' && offDetails.reason === fastDetails.reason
        && fastRun.h.session.iterationCount === limit && offRun.h.session.iterationCount === limit,
      'maxIterations: the existing safety breaker stops the run at the limit of ' + limit + ' with iteration_limit_exceeded, fast iterations counted, exactly as an LLM-only run');
    } finally {
      finish(fastRun);
    }
  }

  const llmMeta = loopRun({
    fast: false,
    providerScript: (index) => H.openAiToolResponse('resp_m' + index, [{ id: 'call_m' + index, name: 'click', args: { selector: '#next' } }])
  });
  try {
    await runSteps(llmMeta, 6);
  } finally {
    finish(llmMeta);
  }
  const meta = loopRun({ content: { entries: NEXT_ENTRIES }, answers: [calibratedPick('click', 'Next')] });
  try {
    await runSteps(meta, 8);
    const metaDetails = meta.h.session.outcomeDetails || {};
    const llmDetails = llmMeta.h.session.outcomeDetails || {};
    check(util.isDeepStrictEqual(iterationsWhere(meta, 'fast'), [2, 3, 4, 6, 7, 8]) && meta.steps[7].schedules === 0,
      'meta_cognitive_loop_break: six effective fast clicks on "Next" on one page path ran in iterations 2-4 and 6-8');
    check(meta.h.session.status === 'stopped' && metaDetails.reason === 'meta_cognitive_loop_break'
      && /6 attempts on `jev:\/start:button:Next`/.test(String(metaDetails.summary)),
    'meta_cognitive_loop_break: the sixth fast click ends the run through the meta-attempt breaker under jev:/start:button:Next');
    check(llmMeta.h.session.status === 'stopped' && llmDetails.reason === 'meta_cognitive_loop_break'
      && /6 attempts on `sel:#next`/.test(String(llmDetails.summary)) && llmMeta.h.session.iterationCount === 6,
    'meta_cognitive_loop_break: exactly as six LLM clicks on one selector do');
  } finally {
    finish(meta);
  }

  const pages = loopRun({
    content: { entries: NEXT_ENTRIES, url: (state) => 'https://wizard.example/wizard/step-' + (state.fastActions + 1) },
    answers: [calibratedPick('click', 'Next')]
  });
  try {
    await runSteps(pages, 10);
    const keys = Object.keys(pages.h.session._metaAttempts || {}).filter((k) => k.indexOf('jev:') === 0);
    const expectedKeys = [];
    for (let n = 1; n <= 7; n += 1) expectedKeys.push('jev:/wizard/step-' + n + ':button:Next');
    check(total(pages, 'fast') === 7 && stillRunning(pages),
      'per-page meta key: seven effective "Next" clicks, one wizard page each, do not end the run');
    check(util.isDeepStrictEqual(keys.slice().sort(), expectedKeys.slice().sort())
      && keys.every((k) => pages.h.session._metaAttempts[k].length === 1),
    'per-page meta key: each click is one attempt under its own jev:<pagePath>:button:Next key');
  } finally {
    finish(pages);
  }
}

function terminalToolChecks() {
  section('latches and budgets: fast mode never applies a terminal outcome (D-17, AUTO-04-c)');
  check(executedFastTools.length > 0 && executedFastTools.every((name) => TERMINAL_TOOLS.indexOf(name) === -1),
    'no executed fast call is named complete_task, partial_task or fail_task (' + executedFastTools.length + ' fast calls across the loop cases)');
  const source = fs.readFileSync(path.join(ROOT, 'extension', 'ai', 'jev-fast-path.js'), 'utf8');
  const slice = sliceFunction(source, 'buildStaticCall');
  check(typeof slice === 'string' && slice.length > 0 && TERMINAL_TOOLS.every((name) => slice.indexOf(name) === -1),
    'jev-fast-path.js buildStaticCall names none of complete_task, partial_task or fail_task');
  check(TERMINAL_TOOLS.every((name) => source.indexOf(name) === -1), 'jev-fast-path.js names no terminal tool anywhere');
}

// ---------------------------------------------------------------------------
// Plan 68-07 Task 2: uncertain outcomes, provider pairing, hand-off collapse,
// exception containment, stop and switch-off (D-05, D-10, D-18, F11, F13,
// F21; AUTO-05-a, AUTO-05-c, AUTO-05-d; sync issue 2).
// ---------------------------------------------------------------------------

const MAY_HAVE_EXECUTED = 'may have executed; inspect the page before retrying';

async function uncertainOutcomeCases() {
  section('outcomes, pairing and containment: uncertain and stale fast steps dispatch once and escalate once (D-18, F11, sync issue 2)');
  const variants = [
    {
      name: 'unknown outcome / mayHaveExecuted',
      action: () => ({
        success: false,
        outcome: 'unknown',
        mayHaveExecuted: true,
        method: 'dom_coordinate',
        message: 'Click dispatched at coordinates; inspect the page before retrying because its effect is unknown'
      }),
      result: (r) => r.success === false && r.error === null,
      stale: false
    },
    {
      name: 'bfCacheDetected',
      action: () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
      result: (r) => r.success === true && r.error === null,
      stale: false
    },
    {
      name: 'stale target',
      action: () => ({ success: false, error: 'Fast-mode target is no longer current (generation_mismatch).', tool: 'click', refStale: true, reason: 'generation_mismatch' }),
      result: (r) => r.success === false && /no longer current/.test(String(r.error)),
      stale: true
    },
    {
      name: 'channel closed',
      action: () => { throw new Error('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'); },
      result: (r) => r.success === false && String(r.error).indexOf('Content tool click failed: A listener indicated') === 0,
      stale: false
    },
    {
      name: 'no answer',
      action: () => undefined,
      result: (r) => r.success === false && r.error === null,
      stale: false
    }
  ];
  for (const v of variants) {
    const label = 'uncertain outcome (' + v.name + ')';
    const run = loopRun({ content: { entries: NEXT_ENTRIES, action: v.action }, answers: [calibratedPick('click', 'Next'), catchAll] });
    try {
      await runSteps(run, 4);
      const allActions = contentActions(run.h.events, 'executeAction');
      check(allActions.length === 1 && run.steps[1].fast === 1 && run.content.state.fastActions === 1,
        label + ': the fast step produced exactly one executeAction in the whole run (iteration 2)');
      const fastEvent = (run.h.session.actionHistory || []).find((e) => e.iteration === 2 && e.decisionSource === 'jev');
      check(fastEvent && v.result(fastEvent.result), label + ': the loop recorded the tool-executor shape for this answer');
      const it3 = run.steps[2];
      check(it3.provider === 1 && it3.menus === 0 && it3.decides === 0 && it3.fast === 0,
        label + ': the next iteration runs the LLM with no further fast step before it');
      const handoffs = handoffsIn(it3);
      const text = handoffs.length === 1 ? handoffs[0].content : '';
      if (v.stale) {
        check(text.indexOf('not run: the target changed') !== -1 && text.indexOf(fastPathApi().describeEscalation('stale')) !== -1
          && text.indexOf('may have executed') === -1,
        label + ': one hand-off with the stale wording (nothing ran) and no may-have-executed claim');
      } else {
        check(text.indexOf(MAY_HAVE_EXECUTED) !== -1 && text.indexOf('click button "Next" (page text): may have executed') !== -1,
          label + ': one hand-off saying the step "' + MAY_HAVE_EXECUTED + '"');
      }
      const allHandoffs = handoffMessages(run.h.session.messages);
      check(allHandoffs.length === 1 && allHandoffs.every((m) => m.content.indexOf('not permitted') === -1),
        label + ': no hand-off says the step was not permitted');
      check(run.steps[3].fast === 0 && stillRunning(run), label + ': no second dispatch afterwards and the session keeps running');
    } finally {
      finish(run);
    }
  }
}

/** Crafted bodies in each format: the pairing check must reject an unpaired call, an orphan result and an interleaved message. */
function pairingSelfTest() {
  const handoff = HANDOFF_PREFIX + '\nFast mode took 1 step.';
  const shapes = {
    openai: {
      call: (id) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'click', arguments: '{}' } }] }),
      result: (id) => ({ role: 'tool', tool_call_id: id, name: 'click', content: '{}' }),
      user: (text) => ({ role: 'user', content: text }),
      wrap: (list) => ({ messages: [{ role: 'system', content: 's' }].concat(list) })
    },
    anthropic: {
      call: (id) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'click', input: {} }] }),
      result: (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '{}' }] }),
      user: (text) => ({ role: 'user', content: text }),
      wrap: (list) => ({ system: [{ type: 'text', text: 's' }], messages: list })
    },
    gemini: {
      call: (id) => ({ role: 'model', parts: [{ functionCall: { id, name: 'click', args: {} } }] }),
      result: (id) => ({ role: 'user', parts: [{ functionResponse: { id, name: 'click', response: {} } }] }),
      user: (text) => ({ role: 'user', parts: [{ text }] }),
      wrap: (list) => ({ contents: list })
    }
  };
  const keyFor = { openai: 'openai', anthropic: 'anthropic', gemini: 'gemini' };
  for (const format of Object.keys(shapes)) {
    const s = shapes[format];
    const good = H.toolPairing(keyFor[format], s.wrap([s.call('c1'), s.result('c1'), s.user(handoff)]));
    const unpaired = H.toolPairing(keyFor[format], s.wrap([s.call('c1'), s.user(handoff)]));
    const orphan = H.toolPairing(keyFor[format], s.wrap([s.user(handoff), s.result('jev_1_2')]));
    const interleaved = H.toolPairing(keyFor[format], s.wrap([s.call('c1'), s.user(handoff), s.result('c1')]));
    check(good.ok && good.userTexts.length === 1 && !unpaired.ok && unpaired.unpaired[0] === 'c1'
      && !orphan.ok && orphan.orphans[0] === 'jev_1_2' && !interleaved.ok,
    'pairing self-test (' + format + ' format): the check rejects an unpaired call, an orphan result and a message between a call and its result');
  }
}

async function pairingCases() {
  section('outcomes, pairing and containment: provider request bodies stay paired across fast steps (D-10, AUTO-05-c)');
  pairingSelfTest();
  const providerKeys = ['xai', 'openai', 'anthropic', 'gemini', 'openrouter', 'lmstudio', 'custom'];
  for (const providerKey of providerKeys) {
    const script = [
      H.providerToolResponse(providerKey, 'resp_p1', [{ id: 'call_p1', name: 'click', args: { selector: '#start' } }]),
      H.providerToolResponse(providerKey, 'resp_p2', [{ id: 'call_p2', name: 'get_page_snapshot', args: {} }]),
      H.providerToolResponse(providerKey, 'resp_p3', [{ id: 'call_p3', name: 'complete_task', args: { summary: 'Wizard finished' } }])
    ];
    const run = loopRun({ providerKey, providerScript: script, answers: [clickNthItem, clickNthItem, catchAll] });
    try {
      await runSteps(run, 5);
      check(run.steps[1].fast === 1 && run.steps[2].fast === 1 && run.steps[3].decides === 1 && run.steps[3].provider === 1,
        'pairing (' + providerKey + '): LLM turn, two fast steps, an escalation and an LLM turn ran in that order');
      const bodies = run.h.providerRequests.map((r) => r.requestBody);
      const reports = bodies.map((body) => H.toolPairing(providerKey, body));
      check(bodies.length === 3 && reports.every((r) => r.ok),
        'pairing (' + providerKey + '): every assistant tool call has its result right after it and no result lacks its call ('
        + reports.map((r) => r.calls.length + '/' + r.results.length).join(' ') + ')');
      check(reports.every((r) => r.calls.concat(r.results).every((id) => !/^jev_/.test(String(id)))),
        'pairing (' + providerKey + '): no fast-step call id appears as a tool call or a tool result');
      const later = reports.slice(1);
      check(later.every((r) => r.userTexts.filter((t) => t.indexOf(HANDOFF_PREFIX) === 0).length === 1),
        'pairing (' + providerKey + '): the hand-off is one plain user-role entry in each later request');
      check(run.h.session.status === 'completed', 'pairing (' + providerKey + '): the LLM ends the task');
    } finally {
      finish(run);
    }
  }
}

async function collapseCase() {
  section('outcomes, pairing and containment: only the newest hand-off keeps its snapshot (D-10)');
  const api = fastPathApi();
  const SUMMARY_PREFIX = api.constants.SUMMARY_PREFIX;
  const SNAPSHOT_HEADER = api.constants.SNAPSHOT_HEADER;
  const SNAPSHOT_COLLAPSED = api.constants.SNAPSHOT_COLLAPSED;
  const run = loopRun({ answers: [clickNthItem, catchAll, clickNthItem, catchAll] });
  try {
    await runSteps(run, 5);
    const handoffs = (run.h.session.messages || []).filter((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.indexOf(SUMMARY_PREFIX) === 0);
    check(handoffs.length === 2 && run.steps[2].provider === 1 && run.steps[4].provider === 1,
      'collapse: two hand-offs in one session (iterations 3 and 5)');
    const first = handoffs.length === 2 ? handoffs[0].content : '';
    const last = handoffs.length === 2 ? handoffs[1].content : '';
    check(first.endsWith(SNAPSHOT_HEADER + '\n' + SNAPSHOT_COLLAPSED) && !/\nSNAP-\d+/.test(first),
      'collapse: the earlier hand-off ends with SNAPSHOT_COLLAPSED and keeps no snapshot text');
    check(/\nSNAP-\d+$/.test(last) && last.indexOf(SNAPSHOT_HEADER + '\nSNAP-') !== -1 && last.indexOf(SNAPSHOT_COLLAPSED) === -1,
      'collapse: only the latest hand-off carries SNAPSHOT_HEADER followed by the snapshot text');
    const inRequest = handoffsIn(run.steps[4]);
    check(inRequest.length === 2 && inRequest[0].content === first && inRequest[1].content === last,
      'collapse: the iteration-5 LLM request sees the collapsed earlier hand-off and the full latest one');
  } finally {
    finish(run);
  }
}

async function exceptionCases() {
  section('outcomes, pairing and containment: a throwing fast path never reaches the iteration\'s API-error handler (F13, AUTO-05-d)');
  const variants = [
    ['beforeTurn throws', 'beforeTurn', function beforeTurnThrows() { throw new Error('fast path beforeTurn failed'); }],
    ['afterStep throws', 'afterStep', function afterStepThrows() { throw new Error('fast path afterStep failed'); }]
  ];
  for (const [label, method, replacement] of variants) {
    const run = loopRun({ answers: [clickNthItem] });
    const real = run.h.fastPath;
    globalThis.FsbFastPath = Object.assign({}, real, { [method]: replacement });
    const stopReasons = [];
    try {
      for (let i = 0; i < 5; i += 1) {
        await runSteps(run, 1);
        stopReasons.push(run.h.session.lastTurnResult ? run.h.session.lastTurnResult.stopReason : null);
      }
      if (method === 'beforeTurn') {
        check(run.steps.every((s) => s.provider === 1 && s.fast === 0 && s.schedules === 1),
          'exception (' + label + '): every iteration runs the LLM and schedules the next one normally');
      } else {
        check(util.isDeepStrictEqual(iterationsWhere(run, 'fast'), [2, 3, 4]) && run.steps.slice(1, 4).every((s) => s.provider === 0 && s.schedules === 1),
          'exception (' + label + '): each fast step completes and the iteration schedules the next one normally');
      }
      check(!run.h.consoleLines.some((line) => line.indexOf('Iteration error') !== -1),
        'exception (' + label + '): the iteration catch never logs "Iteration error"');
      check(stopReasons.every((r) => typeof r === 'string' && r !== 'error'),
        'exception (' + label + '): lastTurnResult.stopReason is never "error" (' + stopReasons.join(',') + ')');
      check(stillRunning(run) && run.h.session.agentState.iterationCount === 5, 'exception (' + label + '): the session is not ended');
    } finally {
      finish(run);
    }
  }
}

async function stopCase() {
  section('outcomes, pairing and containment: a stop during an in-flight decision (F21)');
  const run = loopRun({ answers: [() => new Promise(() => {})] });
  try {
    await runSteps(run, 1);
    const pending = run.h.step();
    let rounds = 0;
    while (run.gw.requests.length === 0 && rounds < 500) {
      await new Promise((resolve) => setImmediate(resolve));
      rounds += 1;
    }
    // No check() here: the harness mutes the console while a step is in flight.
    const wasPending = run.gw.requests.length === 1 && run.rec.calls.length === 1 && run.rec.calls[0].init.signal.aborted === false;
    run.h.session.status = 'stopped';
    globalThis.FsbFastPath.abortInFlight(run.h.session);
    // Bounded wait: an iteration that never returns must fail by name, not
    // end the process silently.
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 2000 && !settled; i += 1) await new Promise((resolve) => setImmediate(resolve));
    if (!settled) run.h.dispose();
    const ev = stepEvents(run.h.events, 2);
    check(settled, 'stop: the in-flight iteration returns once the stop aborts the decision');
    check(wasPending, 'stop: a decide was pending at the gateway when the stop arrived');
    check(ofType(ev, 'provider').length === 0 && contentActions(ev, 'executeAction').length === 0 && ofType(ev, 'schedule').length === 0,
      'stop: runAgentIteration returns with no provider request, no executeAction and no next-iteration schedule');
    check(run.rec.calls[0].init.signal.aborted === true && run.rec.decides[0].signal && run.rec.decides[0].signal.aborted === true,
      'stop: the fetch signal is aborted');
    check(handoffMessages(run.h.session.messages).length === 0 && run.h.session.status === 'stopped',
      'stop: nothing was added to session.messages');
  } finally {
    finish(run);
  }
}

async function switchOffCase() {
  section('outcomes, pairing and containment: turning the switch off mid-run (D-05)');
  const run = loopRun({ answers: [clickNthItem] });
  try {
    await runSteps(run, 2);
    check(run.steps[1].fast === 1, 'switch-off: iteration 2 takes one fast step while the switch is on');
    run.h.storage.local.fsbJevFastModeEnabled = false;
    await runSteps(run, 3);
    const reads = ofType(stepEvents(run.h.events, 3), 'storage-get').length;
    check(reads === 1 && run.steps[2].menus === 0 && run.steps[2].decides === 0 && run.steps[2].provider === 1,
      'switch-off: iteration 3 re-reads the switch, sends no menu request, makes no decide and runs the LLM');
    check(fastStateOf(run).off === true && fastStateOf(run).offReason === 'switch_off', 'switch-off: the session latches fast mode off (switch_off)');
    check(run.steps.slice(3).every((s) => s.menus === 0 && s.decides === 0 && s.provider === 1)
      && ofType(stepEvents(run.h.events, 4), 'storage-get').length === 0 && ofType(stepEvents(run.h.events, 5), 'storage-get').length === 0,
    'switch-off: later iterations make no getJevMenu, no decide and no further switch read');
    const handoffs = handoffsIn(run.steps[2]);
    check(handoffs.length === 1 && handoffs[0].content.indexOf(fastPathApi().describeEscalation('switch_off')) !== -1,
      'switch-off: the fast step taken before the switch went off still reaches the LLM in one hand-off');
    check(stillRunning(run), 'switch-off: the session keeps running');
  } finally {
    finish(run);
  }
}

async function main() {
  await offGoldenCases();
  await offThreeWayCases();
  sliceHashCases();
  seamShapeCases();
  await acceptedStepCases();
  await toolDispatchCase();
  await permissionDenialCase();
  await runTaskCase();
  await containmentCases();
  // Plan 68-07 Task 1: latches and budgets.
  await uncalibratedLatchCases();
  await fallbackClassCases();
  await budgetCases();
  await completionStuckCases();
  await noProgressCases();
  await sameStateCases();
  await breakerCases();
  // Plan 68-07 Task 2: outcomes, pairing and containment.
  await uncertainOutcomeCases();
  await pairingCases();
  await collapseCase();
  await exceptionCases();
  await stopCase();
  await switchOffCase();
  terminalToolChecks();
  // The Task 2 golden cases again, after every fast-mode run in this process.
  section('off golden again after the fast-mode runs (no state leaks between harnesses)');
  const again = await H.runGoldenScenario({ loadFastPath: false });
  check(matchesGolden(again.record, 'run A again'), 'off golden: run A still equals the golden after the fast-mode cases');

  console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
