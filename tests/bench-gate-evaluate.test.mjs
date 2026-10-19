// Phase 71 Plan 06 (EVAL-02, EVAL-01; CONTEXT D-05, D-10..D-16, D-19 and the
// 2026-10-16 amendments): the pure gate evaluator.
//
// One seeded synthetic campaign recipe per verdict branch, built with
// makeCampaign (scripts/bench/gate/lib/synthetic.mjs). Every campaign runs the
// gate's 30 rounds and schedule seeds; the bootstrap uses 400 iterations
// through the options override (the CLI never overrides it). The test gate is
// the committed gate with its corpus lock set to the synthetic corpus, and the
// candidate identities record the committed gate's real sha256.
//
// Pure: no git, no network, no port. The only file reads are the gate file
// and the evaluator's own source (the purity and wallMs-only checks).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REASONS,
  VERDICTS,
  aaFloor,
  completionComparison,
  evaluateGate,
  exerciseStats,
  groupRows,
  jevSafety,
  jevVerdict,
  nonJevSafety,
  nonJevVerdict,
  safetyEventsOf,
  speedComparison,
} from '../scripts/bench/gate/lib/evaluate.mjs';
import { corpusDigest, loadGate } from '../scripts/bench/gate/lib/gate.mjs';
import { defaultIdentity, makeCampaign } from '../scripts/bench/gate/lib/synthetic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE_FILE = 'scripts/bench/gate/release-gate-v1.0.0.json';
const EVALUATE_FILE = path.join(ROOT, 'scripts/bench/gate/lib/evaluate.mjs');
const { gate: REAL_GATE, sha256: GATE_SHA256 } = loadGate(path.join(ROOT, GATE_FILE));
const GATE = Object.freeze({ ...REAL_GATE, corpusLockSha256: corpusDigest(defaultIdentity().tasks) });
const ITERATIONS = 400;
const ROUNDS = REAL_GATE.campaigns.autopilot.minRounds;
const GATE_IDENTITY = Object.freeze({ gate: { path: GATE_FILE, sha256: GATE_SHA256 } });
const JEV_PATHS = ['jev-mcp-run-task', 'jev-autopilot'];

const clone = (value) => JSON.parse(JSON.stringify(value));

function mergeIdentity(extra) {
  return { ...clone(GATE_IDENTITY), ...(extra || {}) };
}

// The V1 baseline at the pin: schema-1 rows for autopilot and claude.
function baselineCampaign(options = {}) {
  return makeCampaign({ seed: 6601, scheduleSeed: REAL_GATE.campaigns.baseline.seed, schemaVersion: 1, rounds: ROUNDS, ...options });
}

// V4 core-gate-71-claude: the candidate build, condition off only.
function claudeCampaign(options = {}) {
  const { identity, ...rest } = options;
  return makeCampaign({
    seed: 6602, scheduleSeed: REAL_GATE.campaigns.claude.seed, arms: ['claude'], conditions: ['off'], rounds: ROUNDS,
    ...rest, identity: mergeIdentity(identity),
  });
}

// V4 core-gate-71-autopilot: off and on interleaved; 'on' is 0.70x by default.
function autopilotCampaign(options = {}) {
  const { identity, ...rest } = options;
  return makeCampaign({
    seed: 7101, scheduleSeed: REAL_GATE.campaigns.autopilot.seed, rounds: ROUNDS, effect: { 'autopilot/on': { speed: 0.7 } },
    ...rest, identity: mergeIdentity(identity),
  });
}

const BASELINE = baselineCampaign();
const CLAUDE = claudeCampaign();
const AUTOPILOT = autopilotCampaign();

function passingSuites() {
  return { ran: true, results: GATE.safety.verifySuites.map((command) => ({ command, exitCode: 0 })) };
}

function evaluate({ autopilot = AUTOPILOT, claude = CLAUDE, baseline = BASELINE, suites = passingSuites(), gate = GATE, fallback } = {}) {
  return evaluateGate({ gate, gateSha256: GATE_SHA256, baseline, autopilot, claude, suites, ...(fallback === undefined ? {} : { fallback }) },
    { iterations: ITERATIONS });
}

// A copy of a campaign whose rows were edited by `edit(runs)`.
function withRows(campaign, edit) {
  const runs = clone(campaign.runs);
  edit(runs);
  return { identity: clone(campaign.identity), runs, safety: campaign.safety };
}

const counted = (row) => row.infraError === null;
const onRows = (runs) => runs.filter((row) => row.condition === 'on' && counted(row));
const jevOf = (result) => result.paths['jev-mcp-run-task'];
const nonJevOf = (result) => result.paths['mcp-non-jev'];

function assertJev(result, verdict, reasons) {
  for (const name of JEV_PATHS) {
    assert.equal(result.paths[name].verdict, verdict, `${name} verdict (reasons ${result.paths[name].reasons.join(', ')})`);
    if (reasons) assert.deepEqual(result.paths[name].reasons, reasons, `${name} reasons`);
  }
}

// Every reason the suite sees, checked against REASONS at the end.
const SEEN_REASONS = new Set();
function record(result) {
  for (const entry of Object.values(result.paths || {})) for (const reason of entry.reasons) SEEN_REASONS.add(reason);
  for (const reason of (result.exercise && result.exercise.reasons) || []) SEEN_REASONS.add(reason);
  return result;
}

const PASS = record(evaluate());

// --- (1) Jev pass -------------------------------------------------------------------------

test('(1) Jev pass: 0.70x on vs off, equal completion, calibrated, one model pair, no events', () => {
  assertJev(PASS, 'pass', []);
  const [a, b] = JEV_PATHS.map((name) => PASS.paths[name]);
  assert.equal(a.label, GATE.paths['jev-mcp-run-task'].label);
  assert.equal(b.label, GATE.paths['jev-autopilot'].label);
  assert.deepEqual({ ...a, label: null }, { ...b, label: null }, 'both Jev paths share every number');
  const speed = a.criteria.speed;
  assert.ok(speed.ci[1] < 1 && speed.estimate <= 0.9 && speed.estimate < speed.aaFloor.ci[0], JSON.stringify(speed.ci));
  assert.ok(Math.abs(speed.estimate - 0.7) < 0.05, `estimate ${speed.estimate}`);
  assert.equal(PASS.exercise.status, 'exercised');
  assert.ok(PASS.exercise.actedShare >= GATE.exercise.minActedShare);
  assert.deepEqual(PASS.exercise.pairs.servedModels.length, 1);
  assert.equal(PASS.exercise.captureArm, 'by_construction');
  assert.equal(nonJevOf(PASS).verdict, 'pass');
  assert.equal(nonJevOf(PASS).source, 'primary');
  assert.deepEqual(PASS.inputs, { iterations: ITERATIONS, seed: GATE.bootstrap.seed, level: GATE.bootstrap.level });
});

// --- (2)-(4) Speed fails ------------------------------------------------------------------

test('(2) speed fail: a CI that crosses 1 (true 1.0) fails with ci_upper_not_below_1', () => {
  const result = record(evaluate({ autopilot: autopilotCampaign({ effect: { 'autopilot/on': { speed: 1.0 } } }) }));
  assertJev(result, 'fail');
  assert.ok(jevOf(result).reasons.includes('ci_upper_not_below_1'), jevOf(result).reasons.join(','));
  const { ci } = jevOf(result).criteria.speed;
  assert.ok(ci[0] < 1 && ci[1] >= 1, JSON.stringify(ci));
});

test('(3) speed fail: a practical effect too small (true 0.95, low noise, CI below 1) fails with estimate_above_max', () => {
  const result = record(evaluate({ autopilot: autopilotCampaign({ effect: { 'autopilot/on': { speed: 0.95 } }, wallMs: { sigma: 0.05 } }) }));
  assertJev(result, 'fail', ['estimate_above_max']);
  const speed = jevOf(result).criteria.speed;
  assert.ok(speed.ci[1] < 1 && speed.estimate > GATE.criteria.jevSpeed.maxEstimate, JSON.stringify(speed.ci));
});

test('(4) speed fail: an estimate inside the control A/A floor (noisy control) fails with not_below_aa_floor', () => {
  const result = record(evaluate({
    autopilot: autopilotCampaign({ effect: { 'autopilot/on': { speed: 0.85 } }, wallMs: { sigma: { 'autopilot/off': 0.8, 'autopilot/on': 0.1 } } }),
  }));
  assertJev(result, 'fail', ['not_below_aa_floor']);
  const speed = jevOf(result).criteria.speed;
  assert.ok(speed.ci[1] < 1 && speed.estimate <= 0.9, JSON.stringify(speed.ci));
  assert.ok(speed.estimate >= speed.aaFloor.ci[0], `estimate ${speed.estimate} floor ${speed.aaFloor.ci[0]}`);
});

// --- (5) Completion -----------------------------------------------------------------------

test('(5) completion fail: on 0.70 vs off 0.90 fails with completion_noninferiority', () => {
  const result = record(evaluate({ autopilot: autopilotCampaign({ effect: { 'autopilot/on': { speed: 0.7, completion: -0.2 } } }) }));
  assertJev(result, 'fail', ['completion_noninferiority']);
  const completion = jevOf(result).criteria.completion;
  assert.ok(completion.ci[0] <= -GATE.criteria.completionMargin, JSON.stringify(completion.ci));
  assert.equal(completion.margin, GATE.criteria.completionMargin);
  assert.equal(jevOf(result).criteria.speed.status, 'pass');
});

// --- (6)-(9) Safety -----------------------------------------------------------------------

test('(6) rule (a): one requestOvercount in an acted on run fails with acted_safety_event', () => {
  const autopilot = autopilotCampaign({ safety: { events: [{ kind: 'requestOvercount', arm: 'autopilot', condition: 'on', acted: true, count: 1 }] } });
  const result = record(evaluate({ autopilot }));
  assertJev(result, 'fail', ['acted_safety_event']);
  const { safety } = jevOf(result).criteria;
  assert.equal(safety.ruleA.events, 1);
  assert.equal(safety.ruleA.byKind.requestOvercount, 1);
  assert.equal(safety.ruleA.eventRunIds.length, 1);
});

test('(7) rule (b): more non-acted events in on than in off fails with excess_llm_path_events', () => {
  const autopilot = autopilotCampaign({
    safety: {
      events: [
        { kind: 'unexpectedMutations', arm: 'autopilot', condition: 'on', acted: false, count: 3 },
        { kind: 'unexpectedMutations', arm: 'autopilot', condition: 'off', count: 1 },
      ],
    },
  });
  const result = record(evaluate({ autopilot }));
  assertJev(result, 'fail', ['excess_llm_path_events']);
  const { ruleA, ruleB } = jevOf(result).criteria.safety;
  assert.equal(ruleA.events, 0);
  assert.equal(ruleB.on.events, 3);
  assert.equal(ruleB.off.events, 1);
  assert.ok(ruleB.on.rate > ruleB.off.rate);
});

test('(8) null safety evidence in one counted on run is inconclusive with safety_unverifiable, never zero', () => {
  const autopilot = autopilotCampaign({ safety: { events: [{ kind: 'unverifiable', arm: 'autopilot', condition: 'on', count: 1 }] } });
  const result = record(evaluate({ autopilot }));
  assertJev(result, 'inconclusive', ['safety_unverifiable']);
  const { safety } = jevOf(result).criteria;
  assert.equal(safety.ruleA.unverifiableRuns + safety.ruleB.on.unverifiableRuns, 1);
  assert.equal(safety.ruleA.events + safety.ruleB.on.events, 0);
});

test('(9) the tighten-only suites: not run is inconclusive, a failing suite fails, a missing result is inconclusive', () => {
  const notRun = record(evaluate({ suites: { ran: false, results: [] } }));
  assertJev(notRun, 'inconclusive', ['suites_not_run']);
  const absent = record(evaluateGate({ gate: GATE, gateSha256: GATE_SHA256, baseline: BASELINE, autopilot: AUTOPILOT, claude: CLAUDE },
    { iterations: ITERATIONS }));
  assertJev(absent, 'inconclusive', ['suites_not_run']);

  const failing = passingSuites();
  failing.results[0].exitCode = 1;
  const failed = record(evaluate({ suites: failing }));
  assertJev(failed, 'fail', ['tighten_only_suite_failed']);
  assert.deepEqual(jevOf(failed).criteria.safety.suites.failed, [GATE.safety.verifySuites[0]]);

  const partial = passingSuites();
  partial.results.pop();
  const missing = record(evaluate({ suites: partial }));
  assertJev(missing, 'inconclusive', ['suites_incomplete']);
  assert.deepEqual(jevOf(missing).criteria.safety.suites.missing, [GATE.safety.verifySuites.at(-1)]);
});

// --- (10) Not exercised -------------------------------------------------------------------

test('(10) not_exercised: uncalibrated acted runs, acted share 0.3, two served models', () => {
  const uncalibrated = record(evaluate({ autopilot: autopilotCampaign({ jev: { calibrated: false } }) }));
  assertJev(uncalibrated, 'not_exercised', ['uncalibrated']);
  assert.ok(uncalibrated.exercise.uncalibratedActedRuns > 0);

  const low = record(evaluate({ autopilot: autopilotCampaign({ jev: { actRate: 0.3 } }) }));
  assertJev(low, 'not_exercised', ['acted_share_below_min']);
  assert.ok(low.exercise.actedShare < GATE.exercise.minActedShare && low.exercise.actedShare > 0.2, `${low.exercise.actedShare}`);

  const models = [
    { servedModel: 'jev-1.13.0', instrumentVersion: 'fsb-jev-instrument-1' },
    { servedModel: 'jev-1.14.0', instrumentVersion: 'fsb-jev-instrument-1' },
  ];
  const twoModels = record(evaluate({ autopilot: autopilotCampaign({ jev: { models } }) }));
  assertJev(twoModels, 'not_exercised', ['model_instrument_pair']);
  assert.deepEqual(twoModels.exercise.pairs.servedModels, ['jev-1.13.0', 'jev-1.14.0']);
});

test('(10) not_exercised: every kind of off-run Jev activity is a condition leak (D-16, 2026-10-16)', () => {
  for (const kind of ['calls', 'local', 'summary']) {
    const autopilot = autopilotCampaign({ jev: { leakOff: { count: 1, kind } } });
    const leak = autopilot.runs.find((row) => row.condition === 'off' && counted(row) && row.jev.source !== null);
    assert.ok(leak, `a leaked off row (${kind})`);
    if (kind === 'calls') assert.equal(leak.jev.jevCalls, 2);
    if (kind === 'local') {
      assert.equal(leak.jev.jevCalls, 0);
      assert.equal(leak.jev.acted, false);
      assert.equal(leak.jev.source, 'measurement');
    }
    if (kind === 'summary') assert.equal(leak.jev.source, 'summary');
    const result = record(evaluate({ autopilot }));
    assertJev(result, 'not_exercised', ['condition_leak']);
    assert.equal(result.exercise.leakRuns, 1);
    assert.deepEqual(result.exercise.leakRunIds, [leak.runId]);
  }
});

// --- (11) Non-Jev MCP path ------------------------------------------------------------------

test('(11) non-Jev pass at 0.95 is labelled faster; at 1.02 it still passes without the label', () => {
  const faster = record(evaluate({ claude: claudeCampaign({ effect: { claude: { speed: 0.95 } } }) }));
  assert.equal(nonJevOf(faster).verdict, 'pass');
  assert.equal(nonJevOf(faster).faster, true);
  assert.ok(nonJevOf(faster).criteria.speed.ci[1] < GATE.criteria.nonJevSpeed.fasterCiUpperBelow);

  const level = record(evaluate({ claude: claudeCampaign({ effect: { claude: { speed: 1.02 } } }) }));
  const { ci } = nonJevOf(level).criteria.speed;
  assert.ok(ci[1] >= 1 && ci[1] <= GATE.criteria.nonJevSpeed.ciUpperAtMost, JSON.stringify(ci));
  assert.equal(nonJevOf(level).verdict, 'pass');
  assert.equal(nonJevOf(level).faster, false);
});

test('(11) non-Jev fails on time (true 1.25) and on excess safety events over the pin', () => {
  const slow = record(evaluate({ claude: claudeCampaign({ effect: { claude: { speed: 1.25 } } }) }));
  assert.equal(nonJevOf(slow).verdict, 'fail');
  assert.deepEqual(nonJevOf(slow).reasons, ['time_noninferiority']);
  assert.ok(nonJevOf(slow).criteria.speed.ci[1] > GATE.criteria.nonJevSpeed.ciUpperAtMost);

  const unsafe = record(evaluate({ claude: claudeCampaign({ safety: { events: [{ kind: 'unexpectedMutations', arm: 'claude', count: 2 }] } }) }));
  assert.equal(nonJevOf(unsafe).verdict, 'fail');
  assert.deepEqual(nonJevOf(unsafe).reasons, ['excess_safety_events']);
  assert.equal(nonJevOf(unsafe).criteria.safety.candidate.events, 2);
  assert.equal(nonJevOf(unsafe).criteria.safety.baseline.events, 0);
  assertJev(unsafe, 'pass', []);
});

// --- (12) False done ----------------------------------------------------------------------

function falseDoneRow(campaign) {
  return campaign.runs.find((row) => row.condition === 'on' && counted(row) && row.pass === false && row.fastMode
    && row.fastMode.outcome === 'done');
}

test('(12) a typed done with a non-success status on a failed acted run fails with acted_safety_event', () => {
  const autopilot = autopilotCampaign({ fastMode: { falseDone: [{ acted: true, count: 1, statusMismatch: true }] } });
  const row = falseDoneRow(autopilot);
  assert.equal(row.claimed.status, 'error');
  assert.equal(row.jev.acted, true);
  const result = record(evaluate({ autopilot }));
  assertJev(result, 'fail', ['acted_safety_event']);
  assert.equal(jevOf(result).criteria.safety.ruleA.byKind.claimedSuccessOnFail, 1);
  assert.deepEqual(safetyEventsOf(row, { gate: GATE, build: 'candidate' }).kinds, ['claimedSuccessOnFail']);
  assert.deepEqual(safetyEventsOf(row, { gate: GATE, build: 'baseline' }).kinds, [], 'the typed outcome counts on candidate rows only');
});

test('(12) the same false done on a non-acted run fails rule (b); with a passing checker it is no event', () => {
  const notActed = autopilotCampaign({ fastMode: { falseDone: [{ acted: false, count: 1, statusMismatch: true }] } });
  assert.equal(falseDoneRow(notActed).jev.acted, false);
  const result = record(evaluate({ autopilot: notActed }));
  assertJev(result, 'fail', ['excess_llm_path_events']);

  const acted = autopilotCampaign({ fastMode: { falseDone: [{ acted: true, count: 1, statusMismatch: true }] } });
  const runId = falseDoneRow(acted).runId;
  const passed = withRows(acted, (runs) => {
    runs.find((row) => row.runId === runId).pass = true;
  });
  assertJev(record(evaluate({ autopilot: passed })), 'pass', []);
});

test('(12) a typed done that agrees with a success status is one event, not two', () => {
  const autopilot = autopilotCampaign({ fastMode: { falseDone: [{ acted: true, count: 1 }] } });
  const row = falseDoneRow(autopilot);
  assert.equal(row.claimed.status, 'success');
  assert.equal(safetyEventsOf(row, { gate: GATE, build: 'candidate' }).events, 1);
  const result = record(evaluate({ autopilot }));
  assertJev(result, 'fail', ['acted_safety_event']);
  assert.equal(jevOf(result).criteria.safety.ruleA.events, 1);
});

// --- (13) Unknown exposure ------------------------------------------------------------------

test('(13) unknown exposure (jev.acted null) counts as acted for rule (a) and as not acted for the acted share', () => {
  const clean = autopilotCampaign({ jev: { unknownRate: 0.1 } });
  const unknown = onRows(clean.runs).filter((row) => row.jev.acted === null);
  assert.ok(unknown.length > 0);
  assert.ok(unknown.every((row) => row.jev.source === null && row.fastMode !== null));
  const passing = record(evaluate({ autopilot: clean }));
  assertJev(passing, 'pass', []);
  const on = onRows(clean.runs);
  const acted = on.filter((row) => row.jev.acted === true).length;
  assert.equal(passing.exercise.actedRuns, acted);
  assert.equal(passing.exercise.actedShare, acted / on.length);
  assert.equal(passing.exercise.unknownExposureRuns, unknown.length);

  const withEvent = autopilotCampaign({
    jev: { unknownRate: 0.1 },
    safety: { events: [{ kind: 'requestOvercount', arm: 'autopilot', condition: 'on', acted: null, count: 1 }] },
  });
  const failed = record(evaluate({ autopilot: withEvent }));
  assertJev(failed, 'fail', ['acted_safety_event']);
  assert.equal(jevOf(failed).criteria.safety.exposure.unknown, unknown.length);
});

// --- (14) No Jev attempt is known exposure ----------------------------------------------------

test('(14) on runs with no Jev attempt (no_block) are non-acted, unflagged, and judged under rule (b)', () => {
  const clean = autopilotCampaign({ jev: { noBlockRate: 0.1 } });
  const noBlock = onRows(clean.runs).filter((row) => row.jev.source === 'no_block');
  assert.ok(noBlock.length > 0);
  assert.ok(noBlock.every((row) => row.jev.acted === false && !row.flags.includes('jev_measurement_missing')));
  const passing = record(evaluate({ autopilot: clean }));
  assertJev(passing, 'pass', []);
  const on = onRows(clean.runs);
  assert.equal(passing.exercise.actedShare, on.filter((row) => row.jev.acted === true).length / on.length);
  assert.equal(passing.exercise.unknownExposureRuns, 0);

  const target = noBlock[0].runId;
  const withEvent = withRows(clean, (runs) => {
    runs.find((row) => row.runId === target).safety.requestOvercount = 1;
  });
  const failed = record(evaluate({ autopilot: withEvent }));
  assertJev(failed, 'fail', ['excess_llm_path_events']);
});

test('(14) summary-sourced rows (jev_measurement_missing) take the summary acted value, never unknown', () => {
  const clean = autopilotCampaign({ jev: { missingRate: 0.1 } });
  const summary = onRows(clean.runs).filter((row) => row.flags.includes('jev_measurement_missing'));
  assert.ok(summary.some((row) => row.jev.acted === true) && summary.some((row) => row.jev.acted === false));
  assert.ok(summary.every((row) => row.jev.source === 'summary' && typeof row.jev.acted === 'boolean'));
  assertJev(record(evaluate({ autopilot: clean })), 'pass', []);

  const edit = (acted) => withRows(clean, (runs) => {
    const id = summary.find((row) => row.jev.acted === acted).runId;
    runs.find((row) => row.runId === id).safety.requestOvercount = 1;
  });
  assertJev(record(evaluate({ autopilot: edit(false) })), 'fail', ['excess_llm_path_events']);
  assertJev(record(evaluate({ autopilot: edit(true) })), 'fail', ['acted_safety_event']);
});

test('(14) no-block on runs whose session detail was never read are unknown exposure (acted for rule (a))', () => {
  const clean = autopilotCampaign({ jev: { detailMissingRate: 0.1 } });
  const unread = onRows(clean.runs).filter((row) => row.flags.includes('session_detail_missing'));
  assert.ok(unread.length > 0);
  assert.ok(unread.every((row) => row.jev.source === null && row.jev.acted === null && row.fastMode === null));
  const passing = record(evaluate({ autopilot: clean }));
  assertJev(passing, 'pass', []);
  const on = onRows(clean.runs);
  assert.equal(passing.exercise.actedShare, on.filter((row) => row.jev.acted === true).length / on.length);
  assert.equal(passing.exercise.unknownExposureRuns, unread.length);

  const withEvent = withRows(clean, (runs) => {
    runs.find((row) => row.runId === unread[0].runId).safety.requestOvercount = 1;
  });
  const failed = record(evaluate({ autopilot: withEvent }));
  assertJev(failed, 'fail', ['acted_safety_event']);
});

// --- Speed reads wallMs only; precedence; determinism ---------------------------------------

test('speed reads only wallMs: huge jevMs, model time and host time change no speed number', () => {
  const noisy = withRows(AUTOPILOT, (runs) => {
    for (const row of runs) {
      if (row.jev && row.jev.jevMs !== null) row.jev.jevMs = 9e12;
      row.fsb.modelMsTotal = 9e12;
      row.fsb.toolMsTotal = 9e12;
      row.wallFromInitMs = 9e12;
    }
  });
  const result = evaluate({ autopilot: noisy });
  assert.deepEqual(jevOf(result).criteria.speed, jevOf(PASS).criteria.speed);
  const groups = groupRows({ autopilot: noisy.runs }, GATE);
  const opts = { iterations: ITERATIONS, seed: GATE.bootstrap.seed, level: GATE.bootstrap.level };
  const original = groupRows({ autopilot: AUTOPILOT.runs }, GATE);
  assert.deepEqual(speedComparison(groups.autopilotOff, groups.autopilotOn, opts),
    speedComparison(original.autopilotOff, original.autopilotOn, opts));
  assert.deepEqual(aaFloor(groups.autopilotOff, opts), aaFloor(original.autopilotOff, opts));
});

test('precedence: a safety fail outranks not exercised, and not exercised outranks a speed fail', () => {
  const unsafe = autopilotCampaign({
    jev: { calibrated: false },
    safety: { events: [{ kind: 'requestOvercount', arm: 'autopilot', condition: 'on', acted: true, count: 1 }] },
  });
  assertJev(record(evaluate({ autopilot: unsafe })), 'fail', ['acted_safety_event']);
  const slow = autopilotCampaign({ jev: { calibrated: false }, effect: { 'autopilot/on': { speed: 1.0 } } });
  assertJev(record(evaluate({ autopilot: slow })), 'not_exercised', ['uncalibrated']);
});

test('the verdict functions apply the precedence to computed criteria', () => {
  const ok = { status: 'pass', reasons: [] };
  const exercised = { status: 'exercised', reasons: [] };
  const base = { speed: ok, completion: ok, safety: ok, exercise: exercised };
  assert.deepEqual(jevVerdict({ criteria: base }), { verdict: 'pass', reasons: [] });
  assert.deepEqual(jevVerdict({ criteria: base, guards: ['underpowered'] }), { verdict: 'inconclusive', reasons: ['underpowered'] });
  assert.deepEqual(jevVerdict({ criteria: { ...base, speed: { status: 'fail', reasons: ['estimate_above_max'] } }, guards: ['underpowered'] }),
    { verdict: 'inconclusive', reasons: ['underpowered'] });
  assert.deepEqual(jevVerdict({
    criteria: { ...base, exercise: { status: 'not_exercised', reasons: ['condition_leak'] }, safety: { status: 'inconclusive', reasons: ['suites_not_run'] } },
  }), { verdict: 'not_exercised', reasons: ['condition_leak'] });
  const fasterSpeed = { status: 'pass', reasons: [], faster: true };
  assert.deepEqual(nonJevVerdict({ criteria: { speed: fasterSpeed, completion: ok, safety: ok } }), { verdict: 'pass', reasons: [], faster: true });
  assert.deepEqual(nonJevVerdict({ criteria: { speed: fasterSpeed, completion: { status: 'fail', reasons: ['completion_noninferiority'] },
    safety: { status: 'fail', reasons: ['excess_safety_events'] } } }), { verdict: 'fail', reasons: ['excess_safety_events'], faster: true });
});

test('the same input gives deep-equal output, and row order changes nothing', () => {
  assert.deepEqual(evaluate(), PASS);
  const reversed = { ...AUTOPILOT, runs: [...AUTOPILOT.runs].reverse() };
  const claudeReversed = { ...CLAUDE, runs: [...CLAUDE.runs].reverse() };
  const result = evaluate({ autopilot: reversed, claude: claudeReversed });
  assert.deepEqual(result.paths, PASS.paths);
  assert.deepEqual(result.exercise, PASS.exercise);
});

// --- Helper contracts -------------------------------------------------------------------------

test('helpers: groups, completion counts, unverifiable sidecar entries and no-data shapes', () => {
  const groups = groupRows({ baseline: BASELINE.runs, autopilot: AUTOPILOT.runs, claude: CLAUDE.runs }, GATE);
  assert.equal(groups.autopilotOff.length + groups.autopilotOn.length, AUTOPILOT.runs.length);
  assert.equal(groups.baselineAutopilot.length + groups.baselineClaude.length, BASELINE.runs.length);
  assert.equal(groups.claudeOff.length, CLAUDE.runs.length);

  const completion = completionComparison(groups.autopilotOff, groups.autopilotOn, GATE.criteria.z);
  assert.equal(completion.control.counted, groups.autopilotOff.filter(counted).length);
  assert.equal(completion.treatment.completed, groups.autopilotOn.filter((row) => counted(row) && row.pass).length);
  assert.ok(Math.abs(completion.diff - (completion.treatment.rate - completion.control.rate)) < 1e-12);
  assert.deepEqual(completionComparison([], groups.autopilotOn, GATE.criteria.z).ci, [null, null]);

  const opts = { iterations: 50, seed: 71, level: 0.95 };
  assert.equal(speedComparison([], groups.autopilotOn, opts).status, 'n/a');
  assert.equal(aaFloor(groups.autopilotOff.filter((row) => row.round === 1), opts).status, 'n/a');

  const pinRow = groups.baselineClaude.find(counted);
  assert.equal(safetyEventsOf(pinRow, { gate: GATE, build: 'baseline', sidecar: null }).unverifiable, true);
  assert.equal(safetyEventsOf(pinRow, { gate: GATE, build: 'baseline', sidecar: new Map() }).unverifiable, true);
  assert.equal(safetyEventsOf(pinRow, { gate: GATE, build: 'baseline', sidecar: BASELINE.safety }).unverifiable, false);

  const pin = nonJevSafety({ baselineRows: groups.baselineClaude, candidateRows: groups.claudeOff, gate: GATE, baselineSidecar: null });
  assert.deepEqual(pin.reasons, ['baseline_safety_unverifiable']);
  const jev = jevSafety({ onRows: groups.autopilotOn, offRows: groups.autopilotOff, gate: GATE, suites: passingSuites() });
  assert.equal(jev.status, 'pass');
  const exercise = exerciseStats({ onRows: [], offRows: groups.autopilotOff, gate: GATE });
  assert.equal(exercise.status, 'not_exercised');
  assert.ok(exercise.reasons.includes('no_on_runs'));
  assert.equal(exercise.actedShare, null);
});

test('the evaluator source is pure and its speed helper names no per-decision timing', () => {
  const source = readFileSync(EVALUATE_FILE, 'utf8');
  assert.equal((source.match(/readFileSync|process\.env|Date\.now|child_process|from '\.\.\/\.\.\/report\.mjs'/g) || []).length, 0);
  const start = source.indexOf('export function speedComparison');
  const end = source.indexOf('export function', start + 10);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /jevMs|latencyMs|modelMs/);
});

test('every reason the fixtures produced is a REASONS code, and verdicts come from VERDICTS', () => {
  assert.ok(Object.isFrozen(REASONS) && Object.isFrozen(VERDICTS));
  assert.ok(SEEN_REASONS.size > 10, `${SEEN_REASONS.size} reasons seen`);
  for (const reason of SEEN_REASONS) {
    assert.ok(REASONS.includes(reason.split(':')[0]), `unknown reason ${reason}`);
    assert.match(reason, /^[a-z][a-z0-9_]*(:[A-Za-z0-9_.]+)?$/);
  }
  for (const entry of Object.values(PASS.paths)) assert.ok(VERDICTS.includes(entry.verdict));
});
