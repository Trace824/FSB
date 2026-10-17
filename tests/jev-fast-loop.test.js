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
