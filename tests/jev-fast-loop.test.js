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
 *     detectStuck are byte-identical to P68_START (68-SYNC-RECHECK.md item h).
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

async function main() {
  await offGoldenCases();
  await offThreeWayCases();
  sliceHashCases();

  console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
