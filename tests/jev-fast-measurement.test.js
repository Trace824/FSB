#!/usr/bin/env node
'use strict';

/**
 * Phase 68 Plan 09 -- fast-mode measurement persistence and projection
 * (AUTO-04, D-23, D-01, T-68-11, T-68-12, T-68-19, T-68-26).
 *
 * The session's jevMeasurement block (68-04/68-05 producers) must reach the
 * history store and get_session_detail, and nothing may change for a session
 * that never used fast mode:
 *
 *   - logger: automation-logger.js saveSession persists jevMeasurement only
 *     when a session has one, through an allowlist clone (no page content,
 *     attempts capped at 100, numbers that are not finite stay null), keeps
 *     the stored block in update mode when the new session has none, and
 *     marks persisted actions decisionSource:'jev' only for fast steps. A
 *     fixed fast-mode-off session saved in new and then update mode is
 *     byte-identical to tests/fixtures/jev-fast-logger-off-session.json,
 *     captured with the logger before the edit.
 *
 * Every save runs through the real logger in a vm context over an in-memory
 * chrome.storage.local and a fixed clock. No network, no ports, no timers.
 * Node 20-safe.
 *
 * Run: node tests/jev-fast-measurement.test.js
 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const vm = require('vm');

// A promise that never settles must not pass as a clean exit.
process.exitCode = 1;

const ROOT = path.join(__dirname, '..');
const LOGGER_PATH = path.join(ROOT, 'extension', 'utils', 'automation-logger.js');
const LOGGER_SOURCE = fs.readFileSync(LOGGER_PATH, 'utf8');
const LOGGER_GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'jev-fast-logger-off-session.json'), 'utf8'));

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

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function hasOwn(obj, key) {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deepEqual(a, b) {
  return util.isDeepStrictEqual(clone(a), clone(b));
}

/** The first differing JSON path between two values, for failure messages. */
function firstDifference(actual, expected, trail) {
  const at = trail || '$';
  if (sameJson(actual, expected)) return null;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') {
    return at + ': ' + JSON.stringify(actual) + ' != ' + JSON.stringify(expected);
  }
  const keys = Array.from(new Set(Object.keys(actual).concat(Object.keys(expected))));
  for (const key of keys) {
    const diff = firstDifference(actual[key], expected[key], at + '.' + key);
    if (diff) return diff;
  }
  return at + ': key order differs';
}

function withoutKey(obj, key) {
  const copy = clone(obj);
  if (copy && typeof copy === 'object') delete copy[key];
  return copy;
}

// ---------------------------------------------------------------------------
// The real logger over in-memory storage and a fixed clock
// ---------------------------------------------------------------------------

function makeStorage(initial) {
  const store = clone(initial || {}) || {};
  return {
    store,
    async get(keys) {
      const out = {};
      for (const key of (Array.isArray(keys) ? keys : [keys])) {
        if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = clone(store[key]);
      }
      return out;
    },
    async set(values) {
      Object.assign(store, clone(values));
    },
    async remove(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
    }
  };
}

/** A Date whose clock is clock.t, so every logger timestamp is fixed. */
function fixedDate(clock) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock.t);
      else super(...args);
    }
    static now() {
      return clock.t;
    }
  }
  return FixedDate;
}

function loadLogger(storage, clock) {
  const sandbox = {
    chrome: { runtime: { id: 'test-extension' }, storage: { local: storage } },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout() { return 1; },
    clearTimeout() {},
    Date: fixedDate(clock),
    Blob: class Blob {},
    URL: { createObjectURL() { return 'blob:test'; } }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(LOGGER_SOURCE, sandbox, { filename: LOGGER_PATH });
  return sandbox.automationLogger;
}

function storedState(storage, sessionId) {
  return {
    record: clone(storage.store.fsbSessionLogs[sessionId]),
    index: clone((storage.store.fsbSessionIndex || []).find((entry) => entry && entry.id === sessionId))
  };
}

/**
 * Replays the golden input through the current logger: the logs, the
 * new-mode save, more logs, the update-mode save. edit(data, phase) may change
 * each save's input ('new' or 'update') and returns the data to save.
 */
async function replayGolden(edit) {
  const input = LOGGER_GOLDEN.input;
  const clock = { t: input.clockStart };
  const storage = makeStorage({ fsbSessionLogs: {}, fsbSessionIndex: [] });
  const logger = loadLogger(storage, clock);
  const sid = input.sessionId;
  const change = typeof edit === 'function' ? edit : (data) => data;
  for (const step of input.logsBeforeFirstSave) {
    clock.t = step.at;
    logger[step.call](...clone(step.args));
  }
  clock.t = input.firstSave.at;
  const savedNew = await logger.saveSession(sid, change(clone(input.firstSave.data), 'new'));
  const newMode = storedState(storage, sid);
  for (const step of input.logsBeforeSecondSave) {
    clock.t = step.at;
    logger[step.call](...clone(step.args));
  }
  clock.t = input.secondSave.at;
  const savedUpdate = await logger.saveSession(sid, change(clone(input.secondSave.data), 'update'));
  const updateMode = storedState(storage, sid);
  return { sid, clock, storage, logger, savedNew, savedUpdate, newMode, updateMode };
}

// ---------------------------------------------------------------------------
// Measurement fixtures (the 68-04 attempt and command shapes)
// ---------------------------------------------------------------------------

const ATTEMPT_KEYS = ['iteration', 'command', 'decisionSource', 'jevCalled', 'servedModel', 'instrumentVersion',
  'calibrationStatus', 'latencyMs', 'usage', 'cost', 'fallback', 'outcome', 'escalationReason', 'op', 'stepOutcome'];
const COMMAND_KEYS = ['command', 'fastSteps', 'jevCalls', 'jevMs', 'usd', 'escalations'];

function sampleAttempt(iteration, over) {
  return Object.assign({
    iteration,
    command: 1,
    decisionSource: 'jev',
    jevCalled: true,
    servedModel: 'jev-1.13.0',
    instrumentVersion: 'fsb-jev-instrument-1',
    calibrationStatus: 'calibrated',
    latencyMs: 120,
    usage: { inputTokens: 900, source: 'provider' },
    cost: { usd: 0.0000378, source: 'provider' },
    fallback: null,
    outcome: 'acted',
    escalationReason: null,
    op: 'click',
    stepOutcome: 'progress'
  }, over || {});
}

function sampleCommand(command, over) {
  return Object.assign({
    command,
    fastSteps: 1,
    jevCalls: 3,
    jevMs: 360,
    usd: { provider: 0.0000756, estimate: null },
    escalations: { operation_below_threshold: 1, timeout: 1 }
  }, over || {});
}

function sampleBlock() {
  return {
    v: 1,
    attempts: [
      sampleAttempt(2),
      sampleAttempt(3, { outcome: 'escalated', escalationReason: 'operation_below_threshold', op: null, stepOutcome: null }),
      sampleAttempt(4, {
        servedModel: null, instrumentVersion: null, calibrationStatus: null, latencyMs: 12,
        usage: { inputTokens: null, source: 'unavailable' }, cost: { usd: null, source: 'unavailable' },
        fallback: 'timeout', outcome: 'escalated', escalationReason: 'timeout', op: null, stepOutcome: null
      }),
      sampleAttempt(6, {
        command: 2, jevCalled: false, servedModel: null, instrumentVersion: null, calibrationStatus: null, latencyMs: null,
        usage: { inputTokens: null, source: 'unavailable' }, cost: { usd: null, source: 'unavailable' },
        fallback: 'sensitive_goal', outcome: 'declined', escalationReason: 'sensitive_goal', op: null, stepOutcome: null
      })
    ],
    commands: [
      sampleCommand(1),
      sampleCommand(2, { fastSteps: 0, jevCalls: 0, jevMs: null, usd: { provider: null, estimate: null }, escalations: { sensitive_goal: 1 } })
    ]
  };
}

const MARK = 'MKR';
const MARK_URL = 'https://mkr.example/checkout?card=MKR';

/** A block whose every level carries keys and values outside the allowlist. */
function hostileBlock() {
  const escalations = JSON.parse('{"__proto__": 4}');
  escalations['Has Space'] = 1;
  escalations[MARK_URL] = 1;
  escalations.no_effect = 2;
  escalations.not_a_count = 'two';
  return {
    v: 1,
    label: MARK,
    url: MARK_URL,
    pageText: MARK + ' page text',
    attempts: [
      Object.assign(sampleAttempt(2), {
        label: MARK + ' Pay now',
        url: MARK_URL,
        title: MARK + ' Checkout',
        visibleText: MARK + ' visible',
        goal: MARK + ' goal',
        usage: { inputTokens: 900, source: 'provider', raw: MARK },
        cost: { usd: 0.0000378, source: 'provider', raw: MARK }
      }),
      sampleAttempt(3, {
        iteration: 2.5,
        command: -1,
        decisionSource: 'llm',
        jevCalled: 'yes',
        servedModel: 'x'.repeat(129),
        instrumentVersion: 'y'.repeat(65),
        calibrationStatus: MARK + ' calibrated',
        latencyMs: Infinity,
        usage: { inputTokens: '900', source: 'estimate' },
        cost: { usd: NaN, source: 'mixed' },
        fallback: 'Timed out on ' + MARK_URL,
        outcome: 'clicked "' + MARK + '"',
        escalationReason: 'Bad Reason',
        op: 'click on ' + MARK,
        stepOutcome: 42
      }),
      'not an attempt',
      null
    ],
    commands: [
      Object.assign(sampleCommand(1, {
        jevMs: -Infinity,
        fastSteps: -1,
        jevCalls: 1.5,
        usd: { provider: -0.1, estimate: Infinity, mixed: 1 },
        escalations
      }), { title: MARK, url: MARK_URL }),
      ['not', 'a', 'command']
    ]
  };
}

/** What the allowlist clone and the projection both make of hostileBlock(). */
function hostileExpected() {
  return {
    v: 1,
    attempts: [
      sampleAttempt(2),
      {
        iteration: null,
        command: null,
        decisionSource: null,
        jevCalled: false,
        servedModel: null,
        instrumentVersion: null,
        calibrationStatus: null,
        latencyMs: null,
        usage: { inputTokens: null, source: 'unavailable' },
        cost: { usd: null, source: 'unavailable' },
        fallback: null,
        outcome: null,
        escalationReason: null,
        op: null,
        stepOutcome: null
      }
    ],
    commands: [
      {
        command: 1,
        fastSteps: null,
        jevCalls: null,
        jevMs: null,
        usd: { provider: null, estimate: null },
        escalations: { no_effect: 2 }
      }
    ]
  };
}

/** The stored block, or an empty stand-in so a missing block fails checks instead of throwing. */
function blockOf(record) {
  const block = record && record.jevMeasurement;
  return block && typeof block === 'object' && Array.isArray(block.attempts) && Array.isArray(block.commands)
    ? block
    : { missing: true, attempts: [], commands: [] };
}

function containsMark(value) {
  const json = JSON.stringify(value) || '';
  return json.indexOf(MARK) !== -1 || json.indexOf('mkr.example') !== -1;
}

// ---------------------------------------------------------------------------
// Logger cases (Task 1)
// ---------------------------------------------------------------------------

async function loggerGoldenCases() {
  section('logger: a fast-mode-off session is stored byte-identically to the pre-edit golden');
  const run = await replayGolden();
  check(run.savedNew === true && run.savedUpdate === true, 'both golden saves succeed');
  check(JSON.stringify(run.newMode, null, 2) === JSON.stringify(LOGGER_GOLDEN.newMode, null, 2),
    'new mode: the stored record and index entry equal the golden byte for byte' + (sameJson(run.newMode, LOGGER_GOLDEN.newMode) ? '' : ' (' + firstDifference(run.newMode, LOGGER_GOLDEN.newMode) + ')'));
  check(JSON.stringify(run.updateMode, null, 2) === JSON.stringify(LOGGER_GOLDEN.updateMode, null, 2),
    'update mode: the stored record and index entry equal the golden byte for byte' + (sameJson(run.updateMode, LOGGER_GOLDEN.updateMode) ? '' : ' (' + firstDifference(run.updateMode, LOGGER_GOLDEN.updateMode) + ')'));
  check(!hasOwn(run.updateMode.record, 'jevMeasurement') && !hasOwn(run.newMode.record, 'jevMeasurement'),
    'an off session stores no jevMeasurement key');

  section('logger: switch on with no Jev activity stores the same record');
  const quiet = await replayGolden((data) => Object.assign(data, {
    fastMode: { enabled: true, stored: true, source: null },
    _fastPath: { off: true, offReason: 'switch_off', pendingSteps: [], recent: [] },
    agentState: Object.assign({}, data.agentState, { jevFast: { command: 1, steps: 0, calls: 0, jevMs: 0, latched: null } }),
    jevMeasurement: undefined
  }));
  check(sameJson(quiet.newMode, LOGGER_GOLDEN.newMode) && sameJson(quiet.updateMode, LOGGER_GOLDEN.updateMode),
    'fastMode, _fastPath and agentState.jevFast never reach the stored record or index');
  for (const value of [null, [], 'block', 42, true]) {
    const odd = await replayGolden((data) => Object.assign(data, { jevMeasurement: clone(value) }));
    check(sameJson(odd.newMode, LOGGER_GOLDEN.newMode) && sameJson(odd.updateMode, LOGGER_GOLDEN.updateMode),
      'a jevMeasurement of ' + JSON.stringify(value) + ' is not an object and is not persisted');
  }
}

async function loggerPersistCases() {
  section('logger: jevMeasurement persists only when present, through the allowlist clone');
  const block = sampleBlock();
  const run = await replayGolden((data, phase) => (phase === 'new' ? Object.assign(data, { jevMeasurement: clone(block) }) : data));
  check(deepEqual(run.newMode.record.jevMeasurement, block), 'new mode persists the block as written by the producers');
  const persisted = blockOf(run.newMode.record);
  check(Object.keys(persisted).join(',') === 'v,attempts,commands', 'the persisted block holds v, attempts and commands only');
  check(persisted.attempts.length === 4 && persisted.attempts.every((a) => Object.keys(a).join(',') === ATTEMPT_KEYS.join(',')),
    'every persisted attempt holds exactly the producer keys, in producer order');
  check(persisted.commands.length === 2 && persisted.commands.every((c) => Object.keys(c).join(',') === COMMAND_KEYS.join(',')),
    'every persisted command holds exactly the producer keys, in producer order');
  check(sameJson(withoutKey(run.newMode.record, 'jevMeasurement'), LOGGER_GOLDEN.newMode.record),
    'apart from the block the new-mode record is the golden record (cost, tokens, timing and summary unchanged)');
  check(sameJson(run.newMode.index, LOGGER_GOLDEN.newMode.index), 'the index entry carries no measurement');
  check(deepEqual(run.updateMode.record.jevMeasurement, block),
    'update mode keeps the stored block when the new session has none');
  check(sameJson(withoutKey(run.updateMode.record, 'jevMeasurement'), LOGGER_GOLDEN.updateMode.record),
    'apart from the block the update-mode record is the golden record');
  check(run.updateMode.record.totalCost === LOGGER_GOLDEN.updateMode.record.totalCost &&
    run.updateMode.record.totalCostBasis === LOGGER_GOLDEN.updateMode.record.totalCostBasis,
    'Jev cost is never folded into totalCost or its basis (D-23)');

  const replaced = sampleBlock();
  replaced.attempts.push(sampleAttempt(9, { command: 2 }));
  run.clock.t += 1000;
  await run.logger.saveSession(run.sid, Object.assign(clone(LOGGER_GOLDEN.input.secondSave.data), { jevMeasurement: clone(replaced) }));
  const third = storedState(run.storage, run.sid);
  check(deepEqual(third.record.jevMeasurement, replaced), 'update mode replaces the stored block when the new session has one');

  const updateOnly = await replayGolden((data, phase) => (phase === 'update' ? Object.assign(data, { jevMeasurement: clone(block) }) : data));
  check(!hasOwn(updateOnly.newMode.record, 'jevMeasurement') && deepEqual(updateOnly.updateMode.record.jevMeasurement, block),
    'a block that first appears in update mode is added to the stored record');

  section('logger: hostile keys and values never reach storage (T-68-11)');
  const hostile = await replayGolden((data, phase) => (phase === 'new' ? Object.assign(data, { jevMeasurement: hostileBlock() }) : data));
  const stored = hostile.newMode.record.jevMeasurement;
  check(deepEqual(stored, hostileExpected()), 'the clone keeps only allowlisted keys and closed-vocabulary values' + (deepEqual(stored, hostileExpected()) ? '' : ' (' + firstDifference(stored, hostileExpected()) + ')'));
  check(!containsMark(hostile.newMode.record.jevMeasurement) && !containsMark(hostile.updateMode.record),
    'no label, url, title, goal or page text marker is stored');
  check(stored && stored.attempts[1] && stored.attempts[1].latencyMs === null && stored.attempts[1].cost.usd === null &&
    stored.commands[0].jevMs === null && stored.commands[0].usd.estimate === null,
    'numbers that are not finite stay null, never 0');

  section('logger: attempts and commands keep the newest 100');
  const many = { v: 1, attempts: [], commands: [] };
  for (let i = 1; i <= 130; i += 1) {
    many.attempts.push(sampleAttempt(i));
    many.commands.push(sampleCommand(i));
  }
  const capped = await replayGolden((data, phase) => (phase === 'new' ? Object.assign(data, { jevMeasurement: many }) : data));
  const cappedBlock = blockOf(capped.newMode.record);
  check(cappedBlock.attempts.length === 100 && cappedBlock.attempts[0].iteration === 31 && cappedBlock.attempts[99].iteration === 130,
    'attempts are capped at 100, newest kept');
  check(cappedBlock.commands.length === 100 && cappedBlock.commands[0].command === 31 && cappedBlock.commands[99].command === 130,
    'commands are capped at 100, newest kept');
}

async function loggerMarkerCases() {
  section('logger: actionHistory carries decisionSource only for fast steps');
  const mark = (data) => {
    data.actionHistory[0].decisionSource = 'llm';
    data.actionHistory[1].decisionSource = 'jev';
    data.actionHistory[2].decisionSource = 'jev';
    if (data.actionHistory[3]) data.actionHistory[3].decisionSource = true;
    if (data.actionHistory[4]) data.actionHistory[4].decisionSource = 'JEV';
    return data;
  };
  const run = await replayGolden(mark);
  for (const [label, state, golden] of [['new', run.newMode, LOGGER_GOLDEN.newMode], ['update', run.updateMode, LOGGER_GOLDEN.updateMode]]) {
    const history = state.record.actionHistory;
    const expected = clone(golden.record.actionHistory);
    expected[1].decisionSource = 'jev';
    check(sameJson(history, expected),
      label + ' mode: only the fast step gains decisionSource:\'jev\', after its existing fields; every other entry is unchanged' + (sameJson(history, expected) ? '' : ' (' + firstDifference(history, expected) + ')'));
    check(sameJson(withoutKey(state.record, 'actionHistory'), withoutKey(golden.record, 'actionHistory')),
      label + ' mode: nothing else in the record changes');
  }
  check(run.updateMode.record.actionHistory.filter((a) => hasOwn(a, 'decisionSource')).length === 1,
    'a failed fast step (filtered out) and non-jev values add no marker');
}

function loggerStaticCases() {
  section('logger: Jev cost never passes through the cost tracker (D-23)');
  check(!/estimateCost|CostTracker/.test(LOGGER_SOURCE), 'automation-logger.js never names estimateCost or CostTracker');
  const at = LOGGER_SOURCE.indexOf('function cloneJevMeasurementForPersistence(');
  check(at !== -1, 'cloneJevMeasurementForPersistence is defined');
  check((LOGGER_SOURCE.match(/cloneJevMeasurementForPersistence\(/g) || []).length >= 3,
    'cloneJevMeasurementForPersistence has a definition and is used by both save modes');
}

async function main() {
  await loggerGoldenCases();
  await loggerPersistCases();
  await loggerMarkerCases();
  loggerStaticCases();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('FAIL: unexpected error', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
