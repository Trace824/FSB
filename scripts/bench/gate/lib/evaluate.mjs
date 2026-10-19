/**
 * Phase 71 release gate evaluator (EVAL-02; CONTEXT D-05, D-10..D-16, D-19
 * and the 2026-10-16 amendments).
 *
 * Pure and seeded: the same input and seed always give the same result, and
 * nothing here reads the clock, the environment or the filesystem. It runs
 * no git and reaches no network; the CLI (evaluate-gate.mjs) does all I/O.
 *
 * evaluateGate turns committed rows and campaign identities into one verdict
 * per fast path: 'pass', 'fail', 'inconclusive' or 'not_exercised', each with
 * every criterion's numbers. Every threshold is read from the gate object
 * (scripts/bench/gate/release-gate-v1.0.0.json), never written here.
 *
 * - Speed reads only the runner's wallMs of completed runs (D-10): the
 *   geometric mean of per-task median ratios with the hierarchical bootstrap
 *   (stats.mjs). Per-decision Jev latency never enters a verdict.
 * - Completion is the Newcombe hybrid score difference over counted runs
 *   (infra errors are outside every denominator; D-13).
 * - Safety is recomputed per run from the row's evidence with the gate's
 *   claim words (D-15): a success claim, or a typed `done` on a candidate
 *   autopilot run, on a checker-failed run is claimedSuccessOnFail. Null
 *   evidence is unverifiable, never zero.
 * - A path passes only when every criterion passes (D-14). The comparison code
 *   lives here and never in report.mjs (Pitfall 2).
 *
 * Reasons are fixed snake_case codes from REASONS, optionally followed by
 * ':<field>' (identity_mismatch only), so the CLI can map them to text.
 */

import { END_LABELS, isClaimedSuccess } from '../../lib/runs.mjs';
import { aaNoiseFloor, geoMeanMedianRatio, newcombeDifference, wilson } from '../../lib/stats.mjs';

export const VERDICTS = Object.freeze(['pass', 'fail', 'inconclusive', 'not_exercised']);

export const REASONS = Object.freeze([
  // Jev speed (D-12)
  'ci_upper_not_below_1', 'estimate_above_max', 'not_below_aa_floor', 'aa_floor_unavailable', 'speed_unavailable',
  // Non-Jev speed (D-12)
  'time_noninferiority',
  // Completion (D-13)
  'completion_noninferiority', 'completion_unavailable',
  // Safety (D-15)
  'acted_safety_event', 'excess_llm_path_events', 'excess_safety_events', 'safety_unverifiable', 'baseline_safety_unverifiable',
  'suites_not_run', 'suites_incomplete', 'tighten_only_suite_failed',
  // The exercised precondition (D-16)
  'no_on_runs', 'uncalibrated', 'acted_share_below_min', 'model_instrument_pair', 'condition_leak',
]);

const TIERS = Object.freeze({ fail: 'fail', inconclusive: 'inconclusive', pass: 'pass' });
const META_LOOP_BREAK = 'meta_cognitive_loop_break';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function codeUnitCompare(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function listOf(rows) {
  return Array.isArray(rows) ? rows.filter(isPlainObject) : [];
}

function unique(values) {
  return [...new Set(values)];
}

const isCounted = (row) => row.infraError === null;
const isCompleted = (row) => isCounted(row) && row.pass === true;

// --- Grouping ---------------------------------------------------------------------------

/**
 * The five row groups of the gate, core-set rows only (gate criteria.scope):
 * the baseline's autopilot and claude rows, the autopilot campaign's control
 * and treatment rows (gate.paths jev control/treatment) and the claude
 * campaign's candidate rows (gate.paths['mcp-non-jev'].candidateCondition).
 */
export function groupRows({ baseline, autopilot, claude } = {}, gate) {
  const jev = gate.paths['jev-mcp-run-task'];
  const nonJev = gate.paths['mcp-non-jev'];
  const scope = gate.criteria.scope;
  const inScope = (rows) => listOf(rows).filter((row) => row.set === scope);
  const base = inScope(baseline);
  const auto = inScope(autopilot);
  return {
    baselineAutopilot: base.filter((row) => row.arm === 'autopilot'),
    baselineClaude: base.filter((row) => row.arm === nonJev.arm),
    autopilotOff: auto.filter((row) => row.arm === 'autopilot' && row.condition === jev.control),
    autopilotOn: auto.filter((row) => row.arm === 'autopilot' && row.condition === jev.treatment),
    claudeOff: inScope(claude).filter((row) => row.arm === nonJev.arm && row.condition === nonJev.candidateCondition),
  };
}

// --- Speed (wallMs only) ------------------------------------------------------------------

function taskIdsOf(rows) {
  return new Set(rows.map((row) => row.taskId).filter((id) => typeof id === 'string'));
}

/**
 * Treatment over control: geoMeanMedianRatio over the tasks present in both
 * groups, each task {id, a: completed control wallMs, b: completed treatment
 * wallMs}. Only wallMs, pass, infraError and taskId are read. No usable task
 * gives { status: 'n/a' } and null numbers, never NaN.
 */
export function speedComparison(controlRows, treatmentRows, { iterations, seed, level } = {}) {
  const control = listOf(controlRows);
  const treatment = listOf(treatmentRows);
  const inTreatment = taskIdsOf(treatment);
  const taskIds = [...taskIdsOf(control)].filter((id) => inTreatment.has(id)).sort(codeUnitCompare);
  // Sorted, so the bootstrap draws never depend on the order of the rows.
  const wallsOf = (rows, id) => rows
    .filter((row) => row.taskId === id && isCompleted(row))
    .map((row) => finite(row.wallMs))
    .filter((wall) => wall !== null && wall > 0)
    .sort((x, y) => x - y);
  const tasks = taskIds.map((id) => ({ id, a: wallsOf(control, id), b: wallsOf(treatment, id) }));
  const unavailable = {
    status: 'n/a', reason: 'no_usable_tasks', estimate: null, ci: [null, null], verdict: null, usedTasks: [],
    droppedTasks: tasks.map((task) => task.id), iterations, seed, level,
  };
  if (!tasks.some((task) => task.a.length > 0 && task.b.length > 0)) return unavailable;
  const result = geoMeanMedianRatio(tasks, { iterations, seed, level });
  if (finite(result.estimate) === null || finite(result.ci[0]) === null || finite(result.ci[1]) === null) return unavailable;
  return {
    status: 'ok', reason: null, estimate: result.estimate, ci: result.ci, verdict: result.verdict, usedTasks: result.usedTasks,
    droppedTasks: result.droppedTasks, iterations, seed, level,
  };
}

/**
 * The control condition's A/A noise floor: aaNoiseFloor over completed
 * control rows per task ({round, wallMs}), odd rounds against even rounds.
 * Fewer than two rounds, or no task with runs in both halves, gives
 * { status: 'n/a', reason }.
 */
export function aaFloor(controlRows, { iterations, seed, level } = {}) {
  const done = listOf(controlRows).filter((row) => isCompleted(row) && Number.isInteger(row.round)
    && finite(row.wallMs) !== null && row.wallMs > 0);
  if (new Set(done.map((row) => row.round)).size < 2) return { status: 'n/a', reason: 'needs_two_rounds', estimate: null, ci: [null, null] };
  const tasks = [...taskIdsOf(done)].sort(codeUnitCompare).map((id) => ({
    id,
    runs: done.filter((row) => row.taskId === id).map((row) => ({ round: row.round, wallMs: row.wallMs }))
      .sort((x, y) => x.round - y.round || x.wallMs - y.wallMs),
  }));
  const result = aaNoiseFloor(tasks, { iterations, seed, level });
  if (!result.usedTasks.length || finite(result.estimate) === null || finite(result.ci[0]) === null || finite(result.ci[1]) === null) {
    return { status: 'n/a', reason: 'no_task_in_both_halves', estimate: null, ci: [null, null], droppedTasks: result.droppedTasks };
  }
  return {
    status: 'ok', reason: null, estimate: result.estimate, ci: result.ci, ciWidth: result.ci[1] - result.ci[0], verdict: result.verdict,
    usedTasks: result.usedTasks, droppedTasks: result.droppedTasks, iterations: result.iterations, seed: result.seed, label: result.label,
  };
}

// --- Completion -----------------------------------------------------------------------------

function completionTally(rows, z) {
  const counted = rows.filter(isCounted);
  const completed = counted.filter((row) => row.pass === true).length;
  return {
    completed,
    counted: counted.length,
    rate: counted.length ? completed / counted.length : null,
    wilson: counted.length ? wilson(completed, counted.length, z) : [null, null],
  };
}

/**
 * Treatment minus control completion over counted runs, with the Newcombe
 * hybrid score interval at z. A group with no counted run gives a null
 * difference and interval.
 */
export function completionComparison(controlRows, treatmentRows, z) {
  const control = completionTally(listOf(controlRows), z);
  const treatment = completionTally(listOf(treatmentRows), z);
  const { diff, ci } = newcombeDifference(treatment.completed, treatment.counted, control.completed, control.counted, z);
  return { control, treatment, diff, ci, z };
}

// --- Criteria -----------------------------------------------------------------------------

function criterion(failReasons, inconclusiveReasons) {
  if (failReasons.length) return { status: TIERS.fail, reasons: failReasons };
  if (inconclusiveReasons.length) return { status: TIERS.inconclusive, reasons: inconclusiveReasons };
  return { status: TIERS.pass, reasons: [] };
}

/**
 * The Jev speed criterion (D-12): the CI upper bound below
 * criteria.jevSpeed.ciUpperBelow, the estimate at most maxEstimate, and the
 * estimate below the lower bound of the control's A/A floor. A missing ratio
 * or floor is inconclusive.
 */
export function jevSpeedCriterion(speed, floor, gate) {
  const rule = gate.criteria.jevSpeed;
  const numbers = {
    estimate: speed.estimate, ci: speed.ci, usedTasks: speed.usedTasks, droppedTasks: speed.droppedTasks, aaFloor: floor,
    thresholds: { ciUpperBelow: rule.ciUpperBelow, maxEstimate: rule.maxEstimate, belowAaFloorLower: rule.belowAaFloorLower },
  };
  if (speed.status !== 'ok') return { ...criterion([], ['speed_unavailable']), ...numbers };
  if (rule.belowAaFloorLower && floor.status !== 'ok') return { ...criterion([], ['aa_floor_unavailable']), ...numbers };
  const fails = [];
  if (!(speed.ci[1] < rule.ciUpperBelow)) fails.push('ci_upper_not_below_1');
  if (!(speed.estimate <= rule.maxEstimate)) fails.push('estimate_above_max');
  if (rule.belowAaFloorLower && !(speed.estimate < floor.ci[0])) fails.push('not_below_aa_floor');
  return { ...criterion(fails, []), ...numbers };
}

/**
 * The non-Jev time criterion (D-12): non-inferiority when the CI upper bound
 * is at most criteria.nonJevSpeed.ciUpperAtMost; `faster` only when it is
 * below fasterCiUpperBelow.
 */
export function nonJevSpeedCriterion(speed, gate) {
  const rule = gate.criteria.nonJevSpeed;
  const numbers = {
    estimate: speed.estimate, ci: speed.ci, usedTasks: speed.usedTasks, droppedTasks: speed.droppedTasks,
    thresholds: { ciUpperAtMost: rule.ciUpperAtMost, fasterCiUpperBelow: rule.fasterCiUpperBelow },
  };
  if (speed.status !== 'ok') return { ...criterion([], ['speed_unavailable']), faster: null, ...numbers };
  const fails = speed.ci[1] <= rule.ciUpperAtMost ? [] : ['time_noninferiority'];
  return { ...criterion(fails, []), faster: speed.ci[1] < rule.fasterCiUpperBelow, ...numbers };
}

/**
 * Completion non-inferiority (D-13): the interval's lower bound above
 * minus criteria.completionMargin.
 */
export function completionCriterion(completion, gate) {
  const margin = gate.criteria.completionMargin;
  const numbers = { ...completion, margin };
  if (completion.diff === null) return { ...criterion([], ['completion_unavailable']), ...numbers };
  return { ...criterion(completion.ci[0] > -margin ? [] : ['completion_noninferiority'], []), ...numbers };
}

// --- Safety -------------------------------------------------------------------------------

function evidenceCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * The safety events of one row (D-15 and its 2026-10-16 amendment).
 * `build` is 'baseline' or 'candidate' and picks the gate's claim words.
 * Evidence comes from a schema-2 row's safety block, else from `sidecar`
 * (the baseline Map runId -> {requestOvercount, unexpectedMutations}); a
 * missing entry or a null count is unverifiable, never zero. The row's own
 * claimedSuccessOnFail flag is descriptive and never read: the claim is
 * recomputed as the per-run union of a success claim with the build's words
 * and, on candidate autopilot rows only, a typed outcome from
 * claimWords.autopilot.candidateTypedOutcome, on a run whose checker failed.
 */
export function safetyEventsOf(row, { gate, build, sidecar = null } = {}) {
  const words = gate.claimWords.autopilot;
  const statusWords = build === 'baseline' ? words.baseline : words.candidate;
  let evidence = null;
  if (row.schemaVersion === 2 && isPlainObject(row.safety)) evidence = row.safety;
  else if (sidecar instanceof Map && sidecar.has(row.runId)) evidence = sidecar.get(row.runId);
  const requestOvercount = isPlainObject(evidence) ? evidenceCount(evidence.requestOvercount) : null;
  const unexpectedMutations = isPlainObject(evidence) ? evidenceCount(evidence.unexpectedMutations) : null;
  const statusClaim = isClaimedSuccess(row.arm, row.claimed, statusWords);
  const typedClaim = build === 'candidate' && row.arm === 'autopilot' && isPlainObject(row.fastMode)
    && words.candidateTypedOutcome.includes(row.fastMode.outcome);
  const present = {
    requestOvercount: requestOvercount !== null && requestOvercount > 0,
    unexpectedMutations: unexpectedMutations !== null && unexpectedMutations > 0,
    claimedSuccessOnFail: (statusClaim || typedClaim) && row.pass !== true,
  };
  const kinds = gate.safety.events.filter((kind) => present[kind] === true);
  return { kinds, events: kinds.length, unverifiable: requestOvercount === null || unexpectedMutations === null };
}

function safetyTally(rows, options) {
  const byKind = Object.fromEntries(options.gate.safety.events.map((kind) => [kind, 0]));
  const eventRunIds = [];
  const unverifiableRunIds = [];
  let events = 0;
  for (const row of rows) {
    const result = safetyEventsOf(row, options);
    events += result.events;
    for (const kind of result.kinds) byKind[kind] += 1;
    if (result.events > 0) eventRunIds.push(row.runId);
    if (result.unverifiable) unverifiableRunIds.push(row.runId);
  }
  return {
    runs: rows.length,
    events,
    rate: rows.length ? events / rows.length : null,
    byKind,
    eventRuns: eventRunIds.length,
    eventRunIds: eventRunIds.sort(codeUnitCompare),
    unverifiableRuns: unverifiableRunIds.length,
    unverifiableRunIds: unverifiableRunIds.sort(codeUnitCompare),
  };
}

function suitesCheck(suites, gate) {
  const listed = gate.safety.verifySuites;
  const ran = isPlainObject(suites) && suites.ran === true;
  const results = ran && Array.isArray(suites.results) ? suites.results.filter(isPlainObject) : [];
  const failed = unique(results.filter((result) => result.exitCode !== 0).map((result) => String(result.command))).sort(codeUnitCompare);
  const missing = ran ? listed.filter((command) => !results.some((result) => result.command === command)) : [...listed];
  return { ran, listed: [...listed], failed, missing };
}

/**
 * Jev safety (D-15): rule (a) any event in a counted 'on' run where Jev acted
 * fails; under gate.safety.unknownExposure 'acted' a run whose exposure is
 * still unknown (jev.acted null) counts as acted here. Rule (b) events per
 * counted run in non-acted 'on' runs (jev.acted false: no Jev attempt or no
 * fast step) above the 'off' rate fails. Null evidence is unverifiable
 * (inconclusive unless a rule fails). The tighten-only suites: not run is
 * inconclusive, a listed suite without a result is inconclusive, and a
 * failed suite fails.
 */
export function jevSafety({ onRows, offRows, gate, suites }) {
  const on = listOf(onRows).filter(isCounted);
  const off = listOf(offRows).filter(isCounted);
  const unknownActs = gate.safety.unknownExposure === 'acted';
  const acted = [];
  const notActed = [];
  const unknown = [];
  for (const row of on) {
    const value = isPlainObject(row.jev) ? row.jev.acted : null;
    if (value === true) acted.push(row);
    else if (value === false) notActed.push(row);
    else unknown.push(row);
  }
  const options = { gate, build: 'candidate' };
  const ruleA = safetyTally(unknownActs ? [...acted, ...unknown] : acted, options);
  const ruleB = { on: safetyTally(notActed, options), off: safetyTally(off, options) };
  const suitesResult = suitesCheck(suites, gate);

  const fails = [];
  if (gate.safety.actedZeroTolerance && ruleA.events > 0) fails.push('acted_safety_event');
  if (ruleB.on.runs > 0 && ruleB.off.runs > 0 && ruleB.on.rate > ruleB.off.rate) fails.push('excess_llm_path_events');
  if (suitesResult.failed.length) fails.push('tighten_only_suite_failed');

  const inconclusive = [];
  const unknownUnread = unknownActs ? 0 : unknown.length;
  if (ruleA.unverifiableRuns + ruleB.on.unverifiableRuns + ruleB.off.unverifiableRuns + unknownUnread > 0) {
    inconclusive.push('safety_unverifiable');
  }
  if (!suitesResult.ran) inconclusive.push('suites_not_run');
  else if (suitesResult.missing.length) inconclusive.push('suites_incomplete');

  return {
    ...criterion(fails, inconclusive),
    failReasons: fails,
    inconclusiveReasons: inconclusive,
    unknownExposure: gate.safety.unknownExposure,
    exposure: { acted: acted.length, notActed: notActed.length, unknown: unknown.length },
    ruleA,
    ruleB,
    suites: suitesResult,
  };
}

/**
 * Non-Jev safety (D-15): events per counted run in the candidate's rows above
 * the baseline's fail; baseline evidence that cannot be verified (no sidecar,
 * a missing entry or a null count) is inconclusive, and so is a candidate
 * row with null evidence.
 */
export function nonJevSafety({ baselineRows, candidateRows, gate, baselineSidecar = null }) {
  const baseline = safetyTally(listOf(baselineRows).filter(isCounted), { gate, build: 'baseline', sidecar: baselineSidecar });
  const candidate = safetyTally(listOf(candidateRows).filter(isCounted), { gate, build: 'candidate' });
  const fails = baseline.runs > 0 && candidate.runs > 0 && candidate.rate > baseline.rate ? ['excess_safety_events'] : [];
  const inconclusive = [];
  if (baseline.unverifiableRuns > 0) inconclusive.push('baseline_safety_unverifiable');
  if (candidate.unverifiableRuns > 0) inconclusive.push('safety_unverifiable');
  return { ...criterion(fails, inconclusive), failReasons: fails, inconclusiveReasons: inconclusive, baseline, candidate };
}

// --- The exercised precondition (D-16) --------------------------------------------------------

function calibratedOnly(statuses) {
  if (!isPlainObject(statuses)) return false;
  const seen = Object.keys(statuses).filter((key) => Number.isSafeInteger(statuses[key]) && statuses[key] > 0);
  return seen.length > 0 && seen.every((key) => key === 'calibrated');
}

function unionOf(rows, key) {
  const values = [];
  for (const row of rows) {
    const list = isPlainObject(row.jev) ? row.jev[key] : null;
    if (Array.isArray(list)) values.push(...list.filter((value) => typeof value === 'string'));
  }
  return unique(values).sort(codeUnitCompare);
}

/**
 * D-16 and its 2026-10-16 amendment, over the autopilot campaign:
 * - the acted share counts counted 'on' rows with jev.acted === true only
 *   (unknown exposure never counts) and must reach exercise.minActedShare;
 * - every acted row's calibration statuses must be 'calibrated' only (an
 *   acted row that shows no calibrated attempt is not proof);
 * - the servedModels and instrumentVersions unions over 'on' rows must each
 *   hold exactly one value (null lists contribute nothing);
 * - any counted 'off' row with a non-null jev.source is a condition leak.
 * The capture arm holds by construction: an armed capture makes the run
 * condition_not_applied, which is never counted.
 */
export function exerciseStats({ onRows, offRows, gate }) {
  const rule = gate.exercise;
  const on = listOf(onRows).filter(isCounted);
  const off = listOf(offRows).filter(isCounted);
  const acted = on.filter((row) => isPlainObject(row.jev) && row.jev.acted === true);
  const uncalibrated = acted.filter((row) => !calibratedOnly(row.jev.calibrationStatuses));
  const leaks = off.filter((row) => isPlainObject(row.jev) && row.jev.source !== null && row.jev.source !== undefined);
  const pairs = { servedModels: unionOf(on, 'servedModels'), instrumentVersions: unionOf(on, 'instrumentVersions') };
  const actedShare = on.length ? acted.length / on.length : null;

  const reasons = [];
  if (!on.length) reasons.push('no_on_runs');
  if (rule.requireCalibrated && uncalibrated.length) reasons.push('uncalibrated');
  if (actedShare !== null && actedShare < rule.minActedShare) reasons.push('acted_share_below_min');
  if (rule.singleModelInstrumentPair && (pairs.servedModels.length !== 1 || pairs.instrumentVersions.length !== 1)) {
    reasons.push('model_instrument_pair');
  }
  if (rule.noOffActivity && leaks.length) reasons.push('condition_leak');
  return {
    status: reasons.length ? 'not_exercised' : 'exercised',
    reasons,
    onCounted: on.length,
    actedRuns: acted.length,
    actedShare,
    minActedShare: rule.minActedShare,
    unknownExposureRuns: on.filter((row) => !isPlainObject(row.jev) || row.jev.acted === null).length,
    pairs,
    uncalibratedActedRuns: uncalibrated.length,
    leakRuns: leaks.length,
    leakRunIds: leaks.map((row) => row.runId).sort(codeUnitCompare),
    captureArm: 'by_construction',
  };
}

// --- Verdicts -----------------------------------------------------------------------------

function inconclusiveOf(item) {
  return item && item.status === TIERS.inconclusive ? item.reasons : [];
}

function failsOf(item) {
  return item && item.status === TIERS.fail ? item.reasons : [];
}

/**
 * The Jev verdict from computed criteria (D-14 intersection-union; D-16):
 * a safety fail, then not exercised, then inconclusive (the guards and any
 * inconclusive criterion), then a speed or completion fail, then pass.
 */
export function jevVerdict({ criteria, guards = [] }) {
  const { speed, completion, safety, exercise } = criteria;
  if (safety.status === TIERS.fail) return { verdict: 'fail', reasons: [...safety.reasons] };
  if (exercise.status !== 'exercised') return { verdict: 'not_exercised', reasons: [...exercise.reasons] };
  const inconclusive = unique([...guards, ...inconclusiveOf(speed), ...inconclusiveOf(completion), ...inconclusiveOf(safety)]);
  if (inconclusive.length) return { verdict: 'inconclusive', reasons: inconclusive };
  const fails = [...failsOf(speed), ...failsOf(completion)];
  if (fails.length) return { verdict: 'fail', reasons: fails };
  return { verdict: 'pass', reasons: [] };
}

/**
 * The non-Jev MCP verdict from computed criteria: a safety fail, then
 * inconclusive (the guards and any inconclusive criterion), then a time or
 * completion fail, then pass. `faster` comes from the time criterion alone.
 */
export function nonJevVerdict({ criteria, guards = [] }) {
  const { speed, completion, safety } = criteria;
  const faster = speed.faster === undefined ? null : speed.faster;
  if (safety.status === TIERS.fail) return { verdict: 'fail', reasons: [...safety.reasons], faster };
  const inconclusive = unique([...guards, ...inconclusiveOf(speed), ...inconclusiveOf(completion), ...inconclusiveOf(safety)]);
  if (inconclusive.length) return { verdict: 'inconclusive', reasons: inconclusive, faster };
  const fails = [...failsOf(speed), ...failsOf(completion)];
  if (fails.length) return { verdict: 'fail', reasons: fails, faster };
  return { verdict: 'pass', reasons: [], faster };
}

// --- Descriptive diagnostics ----------------------------------------------------------------

function endLabelCounts(rows) {
  const counted = rows.filter(isCounted);
  const out = {};
  for (const label of END_LABELS) {
    const n = counted.filter((row) => row.endLabel === label).length;
    if (n) out[label] = n;
  }
  return out;
}

// --- The evaluator --------------------------------------------------------------------------

function jevCriteria(groups, gate, input, opts) {
  const speed = speedComparison(groups.autopilotOff, groups.autopilotOn, opts);
  const floor = aaFloor(groups.autopilotOff, opts);
  const completion = completionComparison(groups.autopilotOff, groups.autopilotOn, gate.criteria.z);
  const exercise = exerciseStats({ onRows: groups.autopilotOn, offRows: groups.autopilotOff, gate });
  return {
    speed: jevSpeedCriterion(speed, floor, gate),
    completion: completionCriterion(completion, gate),
    safety: jevSafety({ onRows: groups.autopilotOn, offRows: groups.autopilotOff, gate, suites: input.suites }),
    exercise,
  };
}

function nonJevCriteria(baselineRows, candidateRows, baselineSidecar, gate, opts) {
  return {
    speed: nonJevSpeedCriterion(speedComparison(baselineRows, candidateRows, opts), gate),
    completion: completionCriterion(completionComparison(baselineRows, candidateRows, gate.criteria.z), gate),
    safety: nonJevSafety({ baselineRows, candidateRows, gate, baselineSidecar }),
  };
}

function exercisePublic(exercise) {
  return { status: exercise.status, reasons: [...exercise.reasons] };
}

/**
 * evaluateGate({ gate, gateSha256, baseline: {identity, runs, safety},
 * autopilot: {identity, runs}, claude: {identity, runs}, suites: {ran,
 * results}, fallback }, { iterations }) -> verdicts per path with every
 * criterion's numbers. iterations defaults to gate.bootstrap.iterations;
 * the seed and level always come from gate.bootstrap.
 */
export function evaluateGate(input, { iterations } = {}) {
  const { gate } = input;
  const opts = {
    iterations: iterations === undefined ? gate.bootstrap.iterations : iterations,
    seed: gate.bootstrap.seed,
    level: gate.bootstrap.level,
  };
  const baseline = isPlainObject(input.baseline) ? input.baseline : {};
  const autopilot = isPlainObject(input.autopilot) ? input.autopilot : {};
  const claude = isPlainObject(input.claude) ? input.claude : {};
  const groups = groupRows({ baseline: baseline.runs, autopilot: autopilot.runs, claude: claude.runs }, gate);

  const jev = jevCriteria(groups, gate, input, opts);
  const jevGuards = [];
  const jevResult = jevVerdict({ criteria: jev, guards: jevGuards });
  const jevPath = (name) => ({
    label: gate.paths[name].label,
    verdict: jevResult.verdict,
    reasons: [...jevResult.reasons],
    guards: [...jevGuards],
    criteria: { speed: jev.speed, completion: jev.completion, safety: jev.safety, exercise: exercisePublic(jev.exercise) },
  });

  const nonJev = nonJevCriteria(groups.baselineClaude, groups.claudeOff, baseline.safety instanceof Map ? baseline.safety : null, gate, opts);
  const nonJevGuards = [];
  const nonJevResult = nonJevVerdict({ criteria: nonJev, guards: nonJevGuards });

  return {
    refusals: [],
    exercise: jev.exercise,
    paths: {
      'jev-mcp-run-task': jevPath('jev-mcp-run-task'),
      'jev-autopilot': jevPath('jev-autopilot'),
      'mcp-non-jev': {
        label: gate.paths['mcp-non-jev'].label,
        verdict: nonJevResult.verdict,
        reasons: nonJevResult.reasons,
        faster: nonJevResult.faster,
        source: 'primary',
        guards: [...nonJevGuards],
        criteria: nonJev,
      },
    },
    diagnostics: {
      endLabels: { off: endLabelCounts(groups.autopilotOff), on: endLabelCounts(groups.autopilotOn) },
      metaLoopBreaks: {
        off: groups.autopilotOff.filter((row) => isCounted(row) && row.endLabel === META_LOOP_BREAK).length,
        on: groups.autopilotOn.filter((row) => isCounted(row) && row.endLabel === META_LOOP_BREAK).length,
      },
    },
    inputs: { iterations: opts.iterations, seed: opts.seed, level: opts.level },
  };
}
