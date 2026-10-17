#!/usr/bin/env node
'use strict';

/**
 * Phase 68 Plan 04 -- FsbFastPath pure core (AUTO-02..AUTO-05).
 *
 * Proves the fast-path decision core offline, with a fake gateway
 * (tests/fixtures/jev-fake-gateway.js) and a test-only calibrated profile:
 *
 *   - module shape: one IIFE, one global, inert load, none of the 67-11
 *     boundary bans, and Jev answers read only through FsbJevPolicy.accept;
 *   - classifyFallback over every CONTRACT.FALLBACK_REASONS member;
 *   - toBuilderInput: the documented element keys only, producer/validator
 *     parity with the real buildRequest and both request validators, and the
 *     empty-target-set decline (sync issue 6);
 *   - evaluateDecision over real FsbJevClient results;
 *   - buildStaticCall: code-held arguments only, pagePath on the call object;
 *   - evidence, no-progress, hand-off text and measurement helpers (Task 2).
 *
 * No network, no ports, no real timers. Node 20-safe.
 *
 * Run: node tests/jev-fast-path.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

// A promise that never settles must not pass as a clean exit.
process.exitCode = 1;

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'extension', 'ai', 'jev-fast-path.js');
const FsbJevState = require(path.join(ROOT, 'extension', 'ai', 'jev-state.js'));
const FsbJevPolicy = require(path.join(ROOT, 'extension', 'ai', 'jev-policy.js'));
const serverValidator = require(path.join(ROOT, 'showcase', 'server', 'src', 'jev', 'validator.js'));
const gateway = require('./fixtures/jev-fake-gateway.js');

const CONTRACT = FsbJevState.CONTRACT;

let FsbFastPath = null;
let loadError = null;
try {
  FsbFastPath = require(MODULE_PATH);
} catch (error) {
  loadError = error;
}

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

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sortedKeys(obj) {
  return Object.keys(obj).sort();
}

async function section(title, body) {
  console.log('\n--- ' + title + ' ---');
  try {
    await body();
  } catch (error) {
    check(false, title + ' ran without throwing (' + (error && error.stack ? error.stack : error) + ')');
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One 68-02 menu entry, a fast-eligible button unless overridden. */
function entry(n, over) {
  return Object.assign({
    handle: 'j' + n,
    role: 'button',
    label: 'Button ' + n,
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

/** One 68-02 menu result. */
function menuOf(entries, over) {
  return Object.assign({
    success: true,
    generation: 'abcd1234-1',
    url: 'https://example.test/wizard/step-2?token=abc#frag',
    title: 'Wizard',
    visibleText: 'Step 2 of 3',
    moreBelow: false,
    signature: 'sig-1',
    count: entries.length,
    truncated: false,
    entries,
    recentHandles: []
  }, over || {});
}

/** The decision menu: Next, an unchecked Alpha box, a risky Pay now and a text field. */
function decisionMenu(over) {
  return menuOf([
    entry(1, { label: 'Next' }),
    entry(2, { role: 'checkbox', label: 'Alpha', ops: ['check_box'], inputType: 'checkbox',
      state: { checked: false, expanded: null, selected: null, pressed: null } }),
    entry(4, { label: 'Pay now', risk: 'commit_word', fastEligible: false }),
    entry(5, { role: 'textbox', label: 'Name', ops: ['click'], inputType: 'text', fastEligible: false })
  ], Object.assign({ moreBelow: true }, over || {}));
}

const GOAL = 'Tick Alpha and go to the next step';

/** The e-id buildRequest gave a handle, or null. */
function idFor(built, handle) {
  for (const id of Object.keys(built.idMap)) if (built.idMap[id] === handle) return id;
  return null;
}

/**
 * Menu -> toBuilderInput -> real buildRequest -> fake-gateway decide ->
 * evaluateDecision. bodyFor(request, built) returns the gateway body.
 */
async function decideOn(menu, bodyFor, opts) {
  const o = opts || {};
  const mapped = FsbFastPath.toBuilderInput(menu, { goal: GOAL, recentActions: [], navigatedInCommand: o.navigated !== false });
  if (!mapped.ok) throw new Error('toBuilderInput declined: ' + mapped.reason);
  const built = FsbJevState.buildRequest(mapped.input);
  if (!built.ok) throw new Error('buildRequest refused: ' + built.reason);
  const client = gateway.makeClient((request) => ({ body: bodyFor(request, built) }));
  const result = await client.decide(built.request);
  const ctx = {
    request: built.request,
    idMap: built.idMap,
    entriesByHandle: mapped.entriesByHandle,
    offeredOps: mapped.offeredOps
  };
  const decision = FsbFastPath.evaluateDecision(result, Object.assign(ctx, o.ctx || {}));
  return { decision, result, built, mapped, client, ctx };
}

/** A calibrated body choosing `op` on `handle` (or the catch-all when handle is null). */
function pick(op, handle, extra) {
  return (request, built) => gateway.calibratedBody(request, Object.assign({
    operation: { choice: op },
    target: { choice: handle === null ? gateway.CATCH_ALL : idFor(built, handle) }
  }, extra || {}));
}

// ---------------------------------------------------------------------------
// Task 1
// ---------------------------------------------------------------------------

async function moduleShape() {
  check(loadError === null && FsbFastPath !== null && typeof FsbFastPath === 'object',
    'extension/ai/jev-fast-path.js loads under Node and exports an object' + (loadError ? ' (' + loadError.message + ')' : ''));
  const source = fs.existsSync(MODULE_PATH) ? fs.readFileSync(MODULE_PATH, 'utf8') : '';
  check(source.length > 0, 'the module source exists');

  // The 67-11 bans and the plan's acceptance greps, case-insensitive where the grep is.
  const bans = [
    ['chrome.', /chrome\./i],
    ['localStorage', /localstorage/i],
    ['serverUrl (any case)', /serverurl/i],
    ['importScripts (any case)', /importscripts/i],
    ['a scheme:// literal', /:\/\//],
    ['systemone', /systemone/i],
    ['api.typesafe.ai', /api\.typesafe\.ai/i],
    ['setTimeout', /settimeout/i],
    ['setInterval', /setinterval/i],
    ['a JEV_* identifier', /\bJEV_[A-Z_]+\b/],
    ['meetsThreshold (D-20)', /meetsThreshold/],
    ['probabilities (D-20)', /probabilities/],
    ['.threshold (D-20)', /\.threshold\b/],
    ['a terminal tool name', /complete_task|partial_task|fail_task/]
  ];
  for (const [name, re] of bans) check(source.length > 0 && !re.test(source), 'the module source contains no ' + name);
  check(!/^(const|let|class|function) /m.test(source), 'no top-level const, let, class or function');
  check(/^\(function initFsbFastPath\(root\) \{\n  'use strict';/m.test(source), 'one named IIFE over root with use strict');
  check((source.match(/root\.FsbFastPath = api;/g) || []).length === 1, 'exactly one root.FsbFastPath = api assignment');
  check(source.includes("if (typeof module !== 'undefined' && module.exports) module.exports = api;"), 'the module.exports guard');
  check(source.trimEnd().endsWith("})(typeof globalThis !== 'undefined' ? globalThis : self);"), 'the IIFE closes over globalThis or self');
  check(/\.accept\(/.test(source), 'Jev decisions are read through FsbJevPolicy.accept');
  const syntax = spawnSync(process.execPath, ['--check', MODULE_PATH], { encoding: 'utf8' });
  check(syntax.status === 0, 'node --check passes' + (syntax.status === 0 ? '' : ' (' + syntax.stderr + ')'));
}

async function inertLoad() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');

  // Only console: a timer, chrome, fetch or require read at load would throw.
  const logs = [];
  const quiet = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) quiet[level] = () => { logs.push(level); };
  const bare = vm.createContext({ console: quiet });
  const before = vm.runInContext('Object.getOwnPropertyNames(globalThis)', bare).slice().sort();
  let error = null;
  try { vm.runInContext(source, bare, { filename: 'extension/ai/jev-fast-path.js' }); } catch (e) { error = e; }
  const after = vm.runInContext('Object.getOwnPropertyNames(globalThis)', bare).slice().sort();
  const added = after.filter((n) => !before.includes(n));
  check(error === null, 'evaluates in a context holding only console' + (error ? ' (' + error.message + ')' : ''));
  check(sameJson(added, ['FsbFastPath']), 'defines exactly the global FsbFastPath (added: ' + added.join(', ') + ')');
  check(logs.length === 0, 'logs nothing at load');

  // With timer spies: no timer call at load. URL is there for the call-time
  // checks below (the module reads it only when a menu or page URL is parsed).
  const timerCalls = [];
  const spy = (name) => function timerSpy() { timerCalls.push(name); return 0; };
  const timed = vm.createContext({ console: quiet, URL, setTimeout: spy('setTimeout'), setInterval: spy('setInterval'),
    clearTimeout: spy('clearTimeout'), clearInterval: spy('clearInterval') });
  vm.runInContext(source, timed);
  check(timerCalls.length === 0, 'makes no timer call at load (' + timerCalls.join(', ') + ')');

  // No require, no FsbJev* global: a missing upstream module makes the caller
  // decline, never throw.
  const api = timed.FsbFastPath;
  let decision = null;
  let threw = null;
  try {
    decision = api.evaluateDecision({ ok: true, calibration: { status: 'calibrated', profileId: 'x' }, decisions: {} },
      { request: null, idMap: {}, entriesByHandle: new Map(), offeredOps: ['click'] });
  } catch (e) { threw = e; }
  check(threw === null && decision && decision.act === false && decision.latch === 'session',
    'with no FsbJevPolicy reachable, evaluateDecision declines with a session latch (' + JSON.stringify(decision) + ')');
  let fallback = null;
  try { fallback = api.classifyFallback('timeout'); } catch (e) { threw = e; }
  check(threw === null && fallback && ['session', 'command', 'iteration'].includes(fallback.latch),
    'with no FsbJevState reachable, classifyFallback still answers a latch class');
  let mapped = null;
  try { mapped = api.toBuilderInput(menuOf([entry(1)]), { goal: GOAL }); } catch (e) { threw = e; }
  check(threw === null && mapped && mapped.ok === true, 'toBuilderInput needs no upstream module');
}

async function constants() {
  const c = FsbFastPath.constants;
  const expected = {
    MENU_CAP: 48,
    FAST_MAX_STEPS: 12,
    FAST_MAX_CALLS: 16,
    FAST_WALL_BUDGET_MS: 20000,
    FAST_MAX_CONSECUTIVE: 3,
    FAST_ESCALATION_LATCH: 3,
    MENU_DEADLINE_MS: 1500,
    SNAPSHOT_DEADLINE_MS: 3000,
    RECENT_ACTIONS_MAX: 10,
    MEASUREMENT_ATTEMPTS_MAX: 100,
    KINDS: ['operation', 'target', 'completion', 'stuck'],
    ELEMENT_OPS: ['click', 'check_box', 'press_enter', 'hover'],
    PAGE_OPS: ['scroll', 'go_back'],
    NEVER_OFFERED: ['type_text', 'select_option'],
    VAULT_TOOL_NAMES: ['fill_credential', 'use_payment_method', 'list_credentials', 'list_payment_methods'],
    FAST_VISUAL_REASON: 'Fast mode: simple step',
    SUMMARY_PREFIX: 'FAST MODE HAND-OFF',
    SNAPSHOT_HEADER: 'Current page snapshot (these refs replace any earlier refs):',
    SNAPSHOT_COLLAPSED: '(Snapshot removed: a later fast-mode hand-off carries the current page.)'
  };
  for (const key of Object.keys(expected)) {
    check(sameJson(c[key], expected[key]), 'constants.' + key + ' is ' + JSON.stringify(expected[key]));
  }
  check(sameJson(sortedKeys(c), Object.keys(expected).sort()), 'constants holds exactly the documented keys');
  check(Object.isFrozen(c) && ['KINDS', 'ELEMENT_OPS', 'PAGE_OPS', 'NEVER_OFFERED', 'VAULT_TOOL_NAMES'].every((k) => Object.isFrozen(c[k])),
    'constants and its arrays are frozen');
  const union = c.ELEMENT_OPS.concat(c.PAGE_OPS, c.NEVER_OFFERED).slice().sort();
  check(sameJson(union, CONTRACT.OPERATIONS.slice().sort()), 'ELEMENT_OPS + PAGE_OPS + NEVER_OFFERED is exactly CONTRACT.OPERATIONS');
  check(c.KINDS.every((k) => CONTRACT.KINDS.includes(k)) && !c.KINDS.includes('risk'), 'KINDS are contract kinds and never ask risk');
}

async function fallbackClasses() {
  const session = ['disabled', 'not_configured', 'spend_cap_reached', 'auth_error', 'upstream_billing', 'unavailable_model',
    'invalid_request', 'invalid_response'];
  const command = ['sensitive_goal'];
  const iteration = ['busy', 'timeout', 'rate_limited', 'upstream_overloaded', 'upstream_error', 'network_error',
    'server_error', 'aborted', 'payload_too_large', 'upstream_rejected'];
  check(CONTRACT.FALLBACK_REASONS.length === 19, 'CONTRACT lists 19 fallback reasons');
  check(sameJson(session.concat(command, iteration).sort(), CONTRACT.FALLBACK_REASONS.slice().sort()),
    'the expected table covers every CONTRACT.FALLBACK_REASONS member exactly once');
  for (const reason of CONTRACT.NON_TRANSIENT_REASONS) {
    check(session.includes(reason), 'NON_TRANSIENT reason ' + reason + ' is in the session class');
  }
  const counts = { session: 0, command: 0, iteration: 0 };
  for (const reason of CONTRACT.FALLBACK_REASONS) {
    const verdict = FsbFastPath.classifyFallback(reason);
    const want = session.includes(reason) ? 'session' : command.includes(reason) ? 'command' : 'iteration';
    check(verdict && verdict.latch === want && verdict.reason === reason, 'classifyFallback(' + reason + ') -> ' + want);
    if (verdict && counts[verdict.latch] !== undefined) counts[verdict.latch] += 1;
  }
  check(sameJson(counts, { session: 8, command: 1, iteration: 10 }), 'classes: 8 session, 1 command, 10 iteration (' + JSON.stringify(counts) + ')');
  for (const odd of ['nope', '', 'TIMEOUT', 'constructor', '__proto__', undefined, null, 7, {}]) {
    const verdict = FsbFastPath.classifyFallback(odd);
    check(verdict && verdict.latch === 'session', 'an unknown reason ' + JSON.stringify(odd) + ' fails closed to a session latch');
  }
}

async function builderInput() {
  const vaultEntry = entry(6, { role: 'textbox', label: 'Email', ops: ['click'], inputType: 'email', fastEligible: false, vaultFilled: true });
  const hostile = entry(7, { label: 'Hostile', value: 'SECRET-VALUE-MARKER', selector: '#SELECTOR-MARKER', ref: 'e9' });
  const menu = menuOf([
    entry(1, { label: 'Next' }),
    entry(2, { role: 'checkbox', label: 'Alpha', ops: ['check_box'], inputType: 'checkbox' }),
    entry(3, { role: 'textbox', label: 'Name', ops: ['click'], inputType: 'text', fastEligible: false }),
    entry(4, { label: 'Pay now', risk: 'commit_word', fastEligible: false }),
    entry(5, { role: 'textbox', label: 'Card number', ops: ['click'], inputType: 'text', autocomplete: 'cc-number', fastEligible: false }),
    vaultEntry,
    hostile
  ]);
  const recent = [];
  for (let i = 0; i < 12; i += 1) recent.push({ op: 'click', targetId: 'j1', changed: i % 2 === 0 });
  recent.push({ op: 'navigate', targetId: null, changed: true });
  recent.push({ op: 'check_box', targetId: 'j99', changed: 'yes' });
  recent.push({ op: 'type_text', targetId: 'j3', changed: true });
  const ctx = { goal: GOAL, recentActions: recent, navigatedInCommand: true };
  const r = FsbFastPath.toBuilderInput(menu, ctx);
  check(r && r.ok === true, 'a menu with fast-eligible entries maps ok');
  const input = r.input;
  check(sameJson(input.kinds, ['operation', 'target', 'completion', 'stuck']), 'kinds are operation, target, completion, stuck');
  check(!Object.prototype.hasOwnProperty.call(input, 'proposedAction'), 'no proposedAction');
  check(input.goal === GOAL, 'goal is the user task text, unchanged');
  check(input.url === menu.url && input.title === menu.title && input.visibleText === menu.visibleText, 'url, title and visibleText come from the menu');
  check(sameJson(sortedKeys(input), ['elements', 'goal', 'kinds', 'offeredOps', 'recentActions', 'title', 'url', 'vaultFilledIds', 'visibleText']),
    'the input holds exactly the buildRequest input keys');
  check(input.elements.length === menu.entries.length && input.elements.every((e, i) => e.id === menu.entries[i].handle),
    'every entry becomes an element whose id is its handle');
  check(input.elements.every((e) => sameJson(sortedKeys(e), ['autocomplete', 'hidden', 'id', 'inputType', 'label', 'ops', 'purpose', 'role'])
    && sameJson(sortedKeys(e.purpose), ['sensitive'])),
  'each element holds exactly id, role, label, ops, inputType, autocomplete, purpose.sensitive and hidden');
  check(!JSON.stringify(input).includes('SECRET-VALUE-MARKER') && !JSON.stringify(input).includes('SELECTOR-MARKER'),
    'an entry\'s value, selector and ref keys never reach the input');
  check(sameJson(input.vaultFilledIds, ['j6']), 'vaultFilledIds lists the vault-filled handle');
  check(sameJson(input.offeredOps, ['click', 'check_box', 'hover', 'go_back']),
    'offeredOps is the union of surviving entry ops plus go_back after a navigation (' + JSON.stringify(input.offeredOps) + ')');
  check(sameJson(r.offeredOps, input.offeredOps), 'the returned offeredOps equal the input offeredOps');
  check(r.entriesByHandle instanceof Map && r.entriesByHandle.get('j1') === menu.entries[0] && r.entriesByHandle.size === menu.entries.length,
    'entriesByHandle maps every handle to its menu entry');
  check(input.recentActions.length === 10, 'at most 10 recent actions (' + input.recentActions.length + ')');
  check(input.recentActions.every((a) => sameJson(sortedKeys(a), ['changed', 'op', 'targetId'])
    && CONTRACT.OPERATIONS.includes(a.op) && typeof a.changed === 'boolean'
    && (a.targetId === null || r.entriesByHandle.has(a.targetId))),
  'each recent action is {op in OPERATIONS, targetId handle-or-null, changed boolean}');
  const last = input.recentActions.slice(-2);
  check(sameJson(last, [{ op: 'check_box', targetId: null, changed: false }, { op: 'type_text', targetId: 'j3', changed: true }]),
    'the newest actions are kept, an op outside OPERATIONS is omitted, an unknown target is null and a non-boolean changed is false');

  const built = FsbJevState.buildRequest(input);
  check(built.ok === true && built.request.elements.length > 0, 'the real buildRequest accepts the input (' + (built.reason || 'ok') + ')');
  check(built.ok && FsbJevState.validateRequest(built.request).ok === true, 'the request passes the extension validateRequest');
  check(built.ok && serverValidator.validateRequest(built.request).ok === true, 'the request passes the server validateRequest');
  check(built.ok && !Object.prototype.hasOwnProperty.call(built.request, 'proposedAction'), 'the request carries no proposedAction');
  check(built.ok && sameJson(built.request.offeredOps, r.offeredOps), 'the request offers exactly the returned offeredOps');
  check(built.ok && Object.values(built.idMap).every((h) => r.entriesByHandle.has(h)), 'idMap maps back to menu handles');
  check(built.ok && !Object.values(built.idMap).includes('j5') && !Object.values(built.idMap).includes('j6'),
    'buildRequest drops the cc-number field and the vault-filled field');
  const wire = built.ok ? JSON.stringify(built.request) : '';
  check(!wire.includes('token=abc') && !wire.includes('frag') && !wire.includes('SECRET-VALUE-MARKER'),
    'the request has no query string, fragment or field value');

  // Page ops.
  const scrollMenu = menuOf([entry(1)], { moreBelow: true });
  check(sameJson(FsbFastPath.toBuilderInput(scrollMenu, { goal: GOAL }).offeredOps, ['click', 'hover', 'scroll']),
    'scroll is offered when the menu reports more content below');
  check(sameJson(FsbFastPath.toBuilderInput(menuOf([entry(1)]), { goal: GOAL, navigatedInCommand: false }).offeredOps, ['click', 'hover']),
    'neither scroll nor go_back without more content or a navigation');

  // Never type_text or select_option.
  const typed = FsbFastPath.toBuilderInput(menuOf([entry(1, { ops: ['type_text', 'select_option', 'click', 'scroll', 'click'] })]), { goal: GOAL });
  check(typed.ok && sameJson(typed.input.elements[0].ops, ['click']) && sameJson(typed.offeredOps, ['click']),
    'an entry claiming type_text, select_option or a page op keeps only its element ops, and offeredOps never hold them');
  const onlyTyped = FsbFastPath.toBuilderInput(menuOf([entry(1, { ops: ['type_text', 'select_option'] })]), { goal: GOAL });
  check(onlyTyped.ok === false && onlyTyped.reason === 'nothing_offerable', 'an entry whose only ops are type_text or select_option offers nothing');

  // nothing_offerable.
  const noEligible = menuOf([entry(3, { role: 'textbox', label: 'Name', ops: ['click'], inputType: 'text', fastEligible: false })]);
  const declined = FsbFastPath.toBuilderInput(noEligible, { goal: GOAL, navigatedInCommand: false });
  check(declined.ok === false && declined.reason === 'nothing_offerable', 'no fast-eligible entry and no page op -> nothing_offerable');
  const scrollOnly = FsbFastPath.toBuilderInput(menuOf(noEligible.entries, { moreBelow: true }), { goal: GOAL });
  check(scrollOnly.ok === true && sameJson(scrollOnly.offeredOps, ['click', 'scroll']), 'a surviving entry plus scroll maps ok even with no fast-eligible entry');
  const emptyMenu = FsbFastPath.toBuilderInput(menuOf([], { moreBelow: true }), { goal: GOAL, navigatedInCommand: true });
  check(emptyMenu.ok === false && emptyMenu.reason === 'nothing_offerable', 'an empty menu offers nothing even with scroll and go_back');

  // menu_invalid.
  const invalid = [
    ['null', null],
    ['a string', 'menu'],
    ['success false', menuOf([entry(1)], { success: false })],
    ['entries not an array', menuOf([entry(1)], { entries: 'x' })],
    ['url not a string', menuOf([entry(1)], { url: null })],
    ['a non-web url', menuOf([entry(1)], { url: 'about:blank' })],
    ['an unparseable url', menuOf([entry(1)], { url: 'not a url' })],
    ['title not a string', menuOf([entry(1)], { title: 7 })],
    ['an entry that is not an object', menuOf([entry(1), null])],
    ['a missing handle', menuOf([entry(1, { handle: undefined })])],
    ['a malformed handle', menuOf([entry(1, { handle: 'e1' })])],
    ['duplicate handles', menuOf([entry(1), entry(1)])],
    ['a non-string role', menuOf([entry(1, { role: 3 })])],
    ['a non-string label', menuOf([entry(1, { label: { text: 'x' } })])],
    ['ops not an array', menuOf([entry(1, { ops: 'click' })])]
  ];
  for (const [name, bad] of invalid) {
    const verdict = FsbFastPath.toBuilderInput(bad, { goal: GOAL });
    check(verdict && verdict.ok === false && verdict.reason === 'menu_invalid', 'menu_invalid for ' + name);
  }
}

async function emptyTargetSet() {
  const menu = menuOf([
    entry(1, { role: 'checkbox', label: 'Done box', ops: [], inputType: 'checkbox',
      state: { checked: true, expanded: null, selected: null, pressed: null }, fastEligible: false }),
    entry(2, { role: 'textbox', label: 'Password', ops: ['click'], inputType: 'password', fastEligible: false }),
    entry(3, { role: 'textbox', label: 'Token', ops: ['click'], inputType: 'hidden', fastEligible: false }),
    entry(4, { role: 'button', label: 'Upload', ops: [], inputType: 'file', fastEligible: false }),
    entry(5, { role: 'textbox', label: 'Card', ops: ['click'], inputType: 'text', autocomplete: 'cc-number', fastEligible: false }),
    entry(6, { label: 'Use saved card', vaultFilled: true, fastEligible: false }),
    entry(7, { label: 'Hidden next', hidden: true, fastEligible: false })
  ], { moreBelow: true });
  const r = FsbFastPath.toBuilderInput(menu, { goal: GOAL, navigatedInCommand: true });
  check(r.ok === false && r.reason === 'nothing_offerable',
    'a menu whose every entry buildRequest would drop declines nothing_offerable although scroll and go_back are offered');
  const bypass = {
    kinds: ['operation', 'target', 'completion', 'stuck'],
    goal: GOAL,
    url: menu.url,
    title: menu.title,
    visibleText: menu.visibleText,
    elements: menu.entries.map((e) => ({ id: e.handle, role: e.role, label: e.label, ops: e.ops, inputType: e.inputType,
      autocomplete: e.autocomplete, purpose: { sensitive: e.purpose.sensitive }, hidden: e.hidden })),
    vaultFilledIds: ['j6'],
    recentActions: [],
    offeredOps: ['scroll', 'go_back']
  };
  const built = FsbJevState.buildRequest(bypass);
  check(built.ok === false && built.reason === 'invalid_request',
    'the real buildRequest refuses the same menu as invalid_request (an empty target question), so the decline is needed');
}

/** mulberry32: a small deterministic PRNG. */
function prng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function parity() {
  const rand = prng(68004);
  const choose = (list) => list[Math.floor(rand() * list.length)];
  const ELEMENT_OPS = FsbFastPath.constants.ELEMENT_OPS;
  let okCount = 0;
  let declineCount = 0;
  let mismatches = 0;
  let okBuildFailures = 0;
  let forcedPageOpMismatches = 0;
  const CASES = 400;
  for (let n = 0; n < CASES; n += 1) {
    const count = Math.floor(rand() * 7);
    const entries = [];
    for (let i = 1; i <= count; i += 1) {
      entries.push(entry(i, {
        role: choose(['button', 'link', 'checkbox', '', 'textbox']),
        label: choose(['Next', 'Alpha', '', 'Open menu', 'Save']),
        ops: choose([[], ['click'], ['click'], ['check_box'], ['hover', 'click'], ['type_text'], ['select_option'], ['press_enter'], ['scroll']]),
        inputType: choose([null, null, null, null, 'text', 'search', 'checkbox', 'password', 'hidden', 'file', ' PASSWORD ', 'File']),
        autocomplete: choose([null, null, null, null, null, 'email', 'username', 'cc-number', 'one-time-code', 'current-password',
          'new-password', 'shipping cc-exp', ' NEW-PASSWORD ']),
        purpose: { sensitive: rand() < 0.08, danger: false, intent: null },
        hidden: rand() < 0.08,
        vaultFilled: rand() < 0.08,
        fastEligible: rand() < 0.5
      }));
    }
    const moreBelow = rand() < 0.4;
    const navigated = rand() < 0.3;
    const menu = menuOf(entries, { moreBelow });

    // Survivors as the real buildRequest judges them: one probe with no target
    // question, the ops reduced to element ops (fast mode never offers others).
    const probe = FsbJevState.buildRequest({
      kinds: ['operation'],
      goal: GOAL,
      url: menu.url,
      title: menu.title,
      visibleText: menu.visibleText,
      elements: entries.map((e) => ({ id: e.handle, role: e.role, label: e.label, ops: e.ops.filter((op) => ELEMENT_OPS.includes(op)),
        inputType: e.inputType, autocomplete: e.autocomplete, purpose: { sensitive: e.purpose.sensitive }, hidden: e.hidden })),
      vaultFilledIds: entries.filter((e) => e.vaultFilled).map((e) => e.handle),
      recentActions: [],
      offeredOps: ['scroll']
    });
    if (!probe.ok) { mismatches += 1; continue; }
    const survivors = new Set(Object.values(probe.idMap));
    const eligible = entries.some((e) => survivors.has(e.handle) && e.fastEligible === true);
    const expectOk = survivors.size > 0 && (eligible || moreBelow || navigated);

    const r = FsbFastPath.toBuilderInput(menu, { goal: GOAL, navigatedInCommand: navigated });
    if (r.ok !== expectOk || (!r.ok && r.reason !== 'nothing_offerable')) mismatches += 1;
    if (r.ok) {
      okCount += 1;
      const built = FsbJevState.buildRequest(r.input);
      if (!built.ok || built.request.elements.length < 1
        || FsbJevState.validateRequest(built.request).ok !== true
        || serverValidator.validateRequest(built.request).ok !== true) okBuildFailures += 1;
    } else {
      declineCount += 1;
    }

    // With a page op always offered, ok is exactly "at least one entry survives".
    const forced = FsbFastPath.toBuilderInput(menuOf(entries, { moreBelow: true }), { goal: GOAL, navigatedInCommand: true });
    if (forced.ok !== (survivors.size > 0)) forcedPageOpMismatches += 1;
  }
  console.log('  generated menus: ' + CASES + ' (ok ' + okCount + ', nothing_offerable ' + declineCount + ')');
  check(okCount >= 50 && declineCount >= 50, 'the generated set exercises both outcomes (ok ' + okCount + ', declined ' + declineCount + ')');
  check(mismatches === 0, 'toBuilderInput is ok exactly when an entry survives buildRequest\'s drop rules and something is offerable (' + mismatches + ' mismatch(es))');
  check(forcedPageOpMismatches === 0, 'with scroll and go_back offered, toBuilderInput is ok exactly when at least one entry survives (' + forcedPageOpMismatches + ' mismatch(es))');
  check(okBuildFailures === 0, 'whenever toBuilderInput is ok, buildRequest is ok with at least one element and both validators accept (' + okBuildFailures + ' failure(s))');
}

async function decisions() {
  // Acts.
  let run = await decideOn(decisionMenu(), pick('click', 'j1'));
  check(run.result.ok === true && run.decision.act === true && run.decision.op === 'click' && run.decision.handle === 'j1'
    && run.decision.entry === run.mapped.entriesByHandle.get('j1'),
  'a calibrated click on a fast-eligible button acts with that handle (' + JSON.stringify(run.decision.act === false ? run.decision : run.decision.op) + ')');
  check(run.client.calls.length === 1 && run.client.timers.lastDelay() === 2500 && run.client.timers.pending() === 0,
    'one fake-gateway call; the held timer recorded the 2500 ms deadline and was cleared');
  run = await decideOn(decisionMenu(), pick('check_box', 'j2'));
  check(run.decision.act === true && run.decision.op === 'check_box' && run.decision.handle === 'j2', 'check_box on an unchecked box acts');

  // Operation not accepted.
  const opCases = [
    ['below_threshold', { choice: 'click', confidence: 0.5, threshold: 0.9 }],
    ['catch_all', { choice: gateway.CATCH_ALL, confidence: 0.95 }],
    ['threshold_null', { choice: 'click', threshold: null }]
  ];
  for (const [reason, spec] of opCases) {
    run = await decideOn(decisionMenu(), (request, built) => gateway.calibratedBody(request, {
      operation: spec, target: { choice: idFor(built, 'j1') } }));
    check(run.decision.act === false && run.decision.reason === 'operation_' + reason && run.decision.latch === 'iteration',
      'operation ' + reason + ' escalates operation_' + reason + ' for one iteration (' + JSON.stringify(run.decision) + ')');
  }
  run = await decideOn(decisionMenu(), pick('click', 'j1'));
  const malformed = JSON.parse(JSON.stringify(run.result));
  malformed.decisions.operation.threshold = 'high';
  const malformedDecision = FsbFastPath.evaluateDecision(malformed, run.ctx);
  check(malformedDecision.act === false && malformedDecision.reason === 'operation_malformed' && malformedDecision.latch === 'session',
    'a malformed operation answer escalates and latches the session (' + JSON.stringify(malformedDecision) + ')');
  const unoffered = JSON.parse(JSON.stringify(run.result));
  unoffered.decisions.operation.choice = 'type_text';
  const unofferedDecision = FsbFastPath.evaluateDecision(unoffered, run.ctx);
  check(unofferedDecision.act === false && unofferedDecision.reason === 'op_not_offered' && unofferedDecision.latch === 'iteration',
    'an operation outside the offered set (type_text) escalates op_not_offered');

  // Target not accepted for element ops.
  for (const [reason, spec] of [['below_threshold', { confidence: 0.4, threshold: 0.9 }], ['catch_all', { choice: gateway.CATCH_ALL }],
    ['threshold_null', { threshold: null }]]) {
    run = await decideOn(decisionMenu(), (request, built) => gateway.calibratedBody(request, {
      operation: { choice: 'click' }, target: Object.assign({ choice: idFor(built, 'j1') }, spec) }));
    check(run.decision.act === false && run.decision.reason === 'target_' + reason && run.decision.latch === 'iteration',
      'click with a target ' + reason + ' escalates target_' + reason);
  }

  // Phase 68's own checks.
  run = await decideOn(decisionMenu(), pick('hover', 'j1'));
  const narrowed = FsbFastPath.evaluateDecision(run.result, Object.assign({}, run.ctx, { offeredOps: ['click', 'check_box', 'scroll', 'go_back'] }));
  check(narrowed.act === false && narrowed.reason === 'op_not_offered', 'an op that is not in offeredOps escalates op_not_offered');
  run = await decideOn(decisionMenu(), pick('click', 'j2'));
  check(run.decision.act === false && run.decision.reason === 'op_not_in_element_ops' && run.decision.latch === 'iteration',
    'click chosen for an entry whose ops are [check_box] escalates op_not_in_element_ops');
  run = await decideOn(decisionMenu(), pick('click', 'j4'));
  check(run.decision.act === false && run.decision.reason === 'risk_excluded', 'a risk-excluded entry escalates risk_excluded');
  run = await decideOn(decisionMenu(), pick('click', 'j5'));
  check(run.decision.act === false && run.decision.reason === 'not_fast_eligible', 'a not-fast-eligible entry escalates not_fast_eligible');
  run = await decideOn(decisionMenu(), pick('click', 'j1'));
  const noMap = FsbFastPath.evaluateDecision(run.result, Object.assign({}, run.ctx, { idMap: {} }));
  check(noMap.act === false && noMap.reason === 'unknown_target', 'a target id absent from idMap escalates unknown_target');
  const noEntry = FsbFastPath.evaluateDecision(run.result, Object.assign({}, run.ctx, { entriesByHandle: new Map() }));
  check(noEntry.act === false && noEntry.reason === 'unknown_target', 'a handle absent from the menu escalates unknown_target');
  const protoMap = FsbFastPath.evaluateDecision(run.result, Object.assign({}, run.ctx, { idMap: Object.create({ e0: 'j1' }) }));
  check(protoMap.act === false && protoMap.reason === 'unknown_target', 'an inherited idMap key is never used');

  // Stuck and completion gates.
  run = await decideOn(decisionMenu(), pick('click', 'j1', { stuck: { p: 0.9, threshold: 0.8 } }));
  check(run.decision.act === false && run.decision.reason === 'jev_stuck' && run.decision.latch === 'iteration', 'an accepted stuck flag escalates jev_stuck');
  run = await decideOn(decisionMenu(), pick('click', 'j1', { completion: { p: 0.5, threshold: 0.2 } }));
  check(run.decision.act === false && run.decision.reason === 'completion_unconfirmed' && run.decision.latch === 'iteration',
    'completion below_threshold escalates completion_unconfirmed (the LLM decides whether it is done)');
  run = await decideOn(decisionMenu(), pick('click', 'j1', { completion: { threshold: null } }));
  check(run.decision.act === true && run.decision.op === 'click', 'completion threshold_null (not a fit) still lets the step act');
  run = await decideOn(decisionMenu(), pick('click', 'j1', { stuck: { threshold: null } }));
  check(run.decision.act === true, 'a stuck question that is not a fit does not block the step');

  // Page-level ops (F22).
  run = await decideOn(decisionMenu(), pick('scroll', null));
  check(run.decision.act === true && run.decision.op === 'scroll' && run.decision.handle === null && run.decision.entry === null,
    'scroll with a catch_all target acts with handle null');
  run = await decideOn(decisionMenu(), (request, built) => gateway.calibratedBody(request, {
    operation: { choice: 'scroll' }, target: { choice: idFor(built, 'j1'), confidence: 0.5, threshold: 0.9 } }));
  check(run.decision.act === true && run.decision.op === 'scroll' && run.decision.handle === null, 'scroll with a below-threshold target acts');
  run = await decideOn(decisionMenu(), (request, built) => gateway.calibratedBody(request, {
    operation: { choice: 'go_back' }, target: { choice: idFor(built, 'j1'), threshold: null } }));
  check(run.decision.act === true && run.decision.op === 'go_back' && run.decision.handle === null, 'go_back with a threshold_null target acts');
  run = await decideOn(decisionMenu(), pick('scroll', 'j1'));
  check(run.decision.act === false && run.decision.reason === 'page_op_with_target' && run.decision.latch === 'iteration',
    'scroll with a confident element target escalates page_op_with_target');
  run = await decideOn(decisionMenu(), pick('go_back', null));
  const noGoBack = FsbFastPath.evaluateDecision(run.result, Object.assign({}, run.ctx, { offeredOps: ['click', 'check_box', 'hover', 'scroll'] }));
  check(noGoBack.act === false && noGoBack.reason === 'op_not_offered', 'go_back that was not offered escalates op_not_offered');

  // Calibration latches.
  run = await decideOn(decisionMenu(), (request) => gateway.uncalibratedBody(request));
  check(run.result.ok === true && run.decision.act === false && run.decision.reason === 'not_calibrated' && run.decision.latch === 'session',
    'an uncalibrated body escalates not_calibrated and latches the session');
  run = await decideOn(decisionMenu(), (request) => gateway.snapshotChangedBody(request));
  check(run.result.ok === true && run.decision.act === false && run.decision.reason === 'not_calibrated' && run.decision.latch === 'session',
    'a snapshot_changed body escalates not_calibrated and latches the session');

  // Every fallback, each through a fresh client (non-transient reasons start a cool-down).
  const mapped = FsbFastPath.toBuilderInput(decisionMenu(), { goal: GOAL, navigatedInCommand: true });
  const built = FsbJevState.buildRequest(mapped.input);
  const ctx = { request: built.request, idMap: built.idMap, entriesByHandle: mapped.entriesByHandle, offeredOps: mapped.offeredOps };
  for (const reason of CONTRACT.GATEWAY_FALLBACK_REASONS) {
    const client = gateway.makeClient(() => ({ status: CONTRACT.HTTP_STATUS_BY_REASON[reason] || 503, body: gateway.fallbackBody(reason) }));
    const result = await client.decide(built.request);
    const decision = FsbFastPath.evaluateDecision(result, ctx);
    const want = FsbFastPath.classifyFallback(reason);
    check(result.ok === false && result.fallback === reason && decision.act === false && decision.reason === reason && decision.latch === want.latch,
      'gateway fallback ' + reason + ' escalates with latch ' + want.latch);
  }
  let client = gateway.makeClient(() => new Error('connection refused'));
  let result = await client.decide(built.request);
  let decision = FsbFastPath.evaluateDecision(result, ctx);
  check(result.fallback === 'network_error' && decision.reason === 'network_error' && decision.latch === 'iteration', 'network_error escalates one iteration');
  client = gateway.makeClient(() => ({ body: gateway.calibratedBody(built.request) }));
  result = await client.decide(built.request, { signal: { aborted: true } });
  decision = FsbFastPath.evaluateDecision(result, ctx);
  check(result.fallback === 'aborted' && client.calls.length === 0 && decision.reason === 'aborted' && decision.latch === 'iteration',
    'an aborted call (no network) escalates one iteration');
  client = gateway.makeClient(() => new Promise(() => {}));
  const pending = client.decide(built.request, { timeoutMs: 900 });
  await new Promise((resolve) => setImmediate(resolve));
  check(client.timers.lastDelay() === 900, 'the held timers see the caller deadline (900 ms)');
  client.timers.fireAll();
  result = await pending;
  decision = FsbFastPath.evaluateDecision(result, ctx);
  check(result.fallback === 'timeout' && decision.reason === 'timeout' && decision.latch === 'iteration', 'a fired deadline gives timeout, one iteration');
  client = gateway.makeClient(() => ({ status: 404, text: '' }));
  result = await client.decide(built.request);
  decision = FsbFastPath.evaluateDecision(result, ctx);
  check(result.fallback === 'invalid_request' && decision.latch === 'session',
    'a pre-deploy 404 maps to invalid_request and latches the session (one call per session, M-68-02)');
  for (const odd of [null, undefined, 'ok', { ok: 'yes' }, { ok: false }]) {
    const d = FsbFastPath.evaluateDecision(odd, ctx);
    check(d && d.act === false && d.latch === 'session', 'a non-result ' + JSON.stringify(odd) + ' fails closed to a session latch');
  }
}

async function staticCalls() {
  const C = FsbFastPath.constants;
  // A hostile ok body: validated, but its free strings carry a marker.
  const run = await decideOn(decisionMenu(), (request, built) => gateway.calibratedBody(request, {
    decisionId: 'HOSTILE-MARKER-decision',
    servedModel: 'HOSTILE-MARKER-model',
    profileId: 'HOSTILE-MARKER-profile',
    operation: { choice: 'click' },
    target: { choice: idFor(built, 'j1') }
  }));
  check(run.result.ok === true && run.result.decisionId === 'HOSTILE-MARKER-decision' && run.decision.act === true,
    'the hostile body passes validation and the decision acts');
  const hostileCall = FsbFastPath.buildStaticCall(run.decision, { generation: 'abcd1234-1', callId: 'jev_0_3', pageUrl: decisionMenu().url });
  check(hostileCall !== null && !JSON.stringify(hostileCall).includes('HOSTILE-MARKER'), 'the call never carries a gateway string');

  const ALLOWED_ARGS = ['jevHandle', 'jevGeneration', 'expectedRole', 'expectedName', 'visual_reason', 'checked', 'direction'];
  const entries = {
    click: entry(1, { label: 'Next' }),
    check_box: entry(2, { role: 'checkbox', label: 'Alpha', ops: ['check_box'], value: 'SECRET-VALUE-MARKER' }),
    press_enter: entry(3, { role: 'searchbox', label: 'Search', ops: ['press_enter'], text: 'TEXT-MARKER' }),
    hover: entry(4, { role: 'menuitem', label: 'More', selector: '#SELECTOR-MARKER', ref: 'e12' })
  };
  const ctx = { generation: 'abcd1234-7', callId: 'jev_1_4', pageUrl: 'https://example.test/wizard/step-2?token=abc#frag' };
  for (const op of C.ELEMENT_OPS.concat(C.PAGE_OPS)) {
    const isElement = C.ELEMENT_OPS.includes(op);
    const e = isElement ? entries[op] : null;
    const call = FsbFastPath.buildStaticCall({ act: true, op, handle: isElement ? e.handle : null, entry: e }, ctx);
    check(call !== null && sameJson(sortedKeys(call), ['args', 'id', 'name', 'pagePath', 'source']),
      op + ': the call holds exactly id, name, args, source and pagePath');
    if (!call) continue;
    check(call.id === 'jev_1_4' && call.name === op && call.source === 'jev' && call.pagePath === '/wizard/step-2',
      op + ': id is the callId, name is the op, source jev, pagePath /wizard/step-2');
    check(Object.keys(call.args).every((k) => ALLOWED_ARGS.includes(k)), op + ': args keys are a subset of the code-held keys (' + Object.keys(call.args).join(', ') + ')');
    check(['text', 'value', 'selector', 'ref', 'pagePath'].every((k) => !Object.prototype.hasOwnProperty.call(call.args, k)),
      op + ': args never hold text, value, selector, ref or pagePath');
    check(!/MARKER/.test(JSON.stringify(call)), op + ': no entry extra (value, text, selector) leaks into the call');
    check(call.args.visual_reason === C.FAST_VISUAL_REASON, op + ': visual_reason is the fixed constant');
    if (isElement) {
      check(call.args.jevHandle === e.handle && call.args.jevGeneration === 'abcd1234-7' && call.args.expectedRole === e.role
        && call.args.expectedName === e.label, op + ': handle, generation, role and name come from the menu entry');
    }
    if (op === 'check_box') check(call.args.checked === true, 'check_box args hold checked === true');
    if (op === 'scroll') check(sameJson(call.args, { direction: 'down', visual_reason: C.FAST_VISUAL_REASON }), 'scroll args are {direction: down, visual_reason}');
    if (op === 'go_back') check(sameJson(call.args, { visual_reason: C.FAST_VISUAL_REASON }), 'go_back args are {visual_reason}');
    if (op === 'click' || op === 'hover' || op === 'press_enter') {
      check(sameJson(sortedKeys(call.args), ['expectedName', 'expectedRole', 'jevGeneration', 'jevHandle', 'visual_reason']),
        op + ' args are exactly the four target keys and visual_reason');
    }
  }

  // pagePath.
  const pathOf = (url) => {
    const call = FsbFastPath.buildStaticCall({ act: true, op: 'scroll', handle: null, entry: null }, { generation: 'g', callId: 'c', pageUrl: url });
    return call ? call.pagePath : undefined;
  };
  check(pathOf('https://example.test/wizard/step-2?token=abc#frag') === '/wizard/step-2', 'pagePath drops the origin, query and fragment');
  check(pathOf('not a url') === '' && pathOf(undefined) === '' && pathOf('about:blank') === '', 'pagePath is empty when the url does not parse or is not a web page');
  const long = pathOf('https://example.test/' + 'a'.repeat(200));
  check(typeof long === 'string' && long.length === 60, 'pagePath is at most 60 characters');

  // The content verbs executeContentTool sends (tool-executor.js) map back to the ops.
  const defs = require(path.join(ROOT, 'extension', 'ai', 'tool-definitions.js'));
  const VERBS = { click: 'click', check_box: 'toggleCheckbox', press_enter: 'pressEnter', hover: 'hover' };
  for (const op of C.ELEMENT_OPS) {
    const call = FsbFastPath.buildStaticCall({ act: true, op, handle: entries[op].handle, entry: entries[op] }, ctx);
    const tool = defs.getToolByName(call.name);
    check(tool && tool._route === 'content' && tool._contentVerb === VERBS[op],
      op + ': the registry tool routes to content with verb ' + VERBS[op]);
  }
  for (const op of C.PAGE_OPS) {
    check(Boolean(defs.getToolByName(op)), op + ' is a registry tool');
  }

  // Refusals.
  const refusals = [
    ['an escalation', { act: false, reason: 'jev_stuck', latch: 'iteration' }],
    ['an unknown op', { act: true, op: 'complete_task', handle: null, entry: null }],
    ['type_text', { act: true, op: 'type_text', handle: 'j1', entry: entries.click }],
    ['an element op with no handle', { act: true, op: 'click', handle: null, entry: entries.click }],
    ['an element op with no entry', { act: true, op: 'click', handle: 'j1', entry: null }],
    ['null', null]
  ];
  for (const [name, d] of refusals) {
    check(FsbFastPath.buildStaticCall(d, ctx) === null, 'buildStaticCall refuses ' + name);
  }
  check(FsbFastPath.buildStaticCall({ act: true, op: 'click', handle: 'j1', entry: entries.click }, { generation: 7, callId: 'c', pageUrl: '' }) === null,
    'buildStaticCall refuses a non-string generation');
  check(FsbFastPath.buildStaticCall({ act: true, op: 'scroll', handle: null, entry: null }, { generation: 'g', callId: '', pageUrl: '' }) === null,
    'buildStaticCall refuses an empty callId');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Phase 68 Plan 04 -- FsbFastPath pure core');
  await section('module shape and the 67-11 bans (D-08, D-17 of 67, D-20)', moduleShape);
  if (FsbFastPath === null) {
    check(false, 'the remaining sections need the module');
  } else {
    await section('inert load (one global, no timer, upstream resolved at call time)', inertLoad);
    await section('constants', constants);
    await section('classifyFallback over CONTRACT.FALLBACK_REASONS (D-16, F9)', fallbackClasses);
    await section('toBuilderInput: documented keys, request parity (D-11, D-13, D-15, gotcha 6)', builderInput);
    await section('the empty target set declines before buildRequest (sync issue 6)', emptyTargetSet);
    await section('parity over generated menus (gotcha 6)', parity);
    await section('evaluateDecision over real client results (D-16, D-17, F22)', decisions);
    await section('buildStaticCall: code-held arguments only (D-15, F1, F2, AUTO-03)', staticCalls);
  }

  console.log('\n--- Summary ---');
  console.log('passed: ' + passed);
  console.log('failed: ' + failed);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('FAIL: unexpected error: ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
