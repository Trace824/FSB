/**
 * Phase 67 / JEV-04, JEV-07 -- the body-free Jev ledger and its daily aggregate.
 *
 * Covers showcase/server/src/db/schema.js (jev_decisions + jev_daily) and
 * showcase/server/src/jev/ledger.js (D-06, D-07, D-08, D-23, D-24, Pitfalls 9
 * and 13) on in-memory SQLite:
 *   - the two tables hold exactly the allowlisted, body-free columns (no goal,
 *     URL, origin, title, text, label, element id, hash key or IP) and
 *     initializeDatabase stays idempotent;
 *   - recordDecision writes the ledger row and the daily UPSERT (with its
 *     spend-cap accrual) in one transaction, keeps usage and cost with their
 *     sources (null, never 0) and stores the served model verbatim;
 *   - recordDecision accepts only LEDGER_OUTCOMES and CONTRACT.KINDS, and a
 *     rejected or failed write leaves both tables untouched;
 *   - recordAggregateOnly touches one jev_daily row per (day, outcome) and never
 *     a ledger row, so refused traffic stays bounded;
 *   - todaySpendUsd, pruneJevLedger, dayUtcKey and the allowlisted
 *     formatDecisionLog line.
 *
 * Run: node tests/jev-gateway-ledger.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'showcase', 'server');
const SERVER_NM = path.join(SERVER_DIR, 'node_modules');
const JEV_DIR = path.join(SERVER_DIR, 'src', 'jev');

const Database = require(require.resolve('better-sqlite3', { paths: [SERVER_NM] }));
const { initializeDatabase } = require(path.join(SERVER_DIR, 'src', 'db', 'schema'));
const { CONTRACT } = require(path.join(JEV_DIR, 'contract.js'));

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.log(`  FAIL: ${label}${detail === undefined ? '' : ` -- ${detail}`}`); }
}
function deepEqual(a, b) {
  try { assert.deepStrictEqual(a, b); return true; } catch (_e) { return false; }
}
function show(value) {
  try { return JSON.stringify(value); } catch (_e) { return String(value); }
}
function approx(a, b) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-12;
}

function loadModule(file) {
  try {
    return require(path.join(JEV_DIR, file));
  } catch (error) {
    check(`${file} loads`, false, error && error.code ? error.code : 'require failed');
    return null;
  }
}

const NOW = Date.UTC(2026, 4, 14, 12, 0, 0); // 2026-05-14 12:00 UTC
const ONE_DAY_MS = 86400000;
const TODAY = '2026-05-14';

const EXPECTED_DECISION_COLUMNS = [
  'id', 'decision_id', 'created_at', 'day_utc', 'outcome', 'served_model',
  'instrument_version', 'calibration_status', 'kinds', 'element_count',
  'request_bytes', 'input_tokens', 'usage_source', 'cost_usd', 'cost_source',
  'upstream_latency_ms', 'gateway_latency_ms', 'upstream_status', 'hash_key_present',
];
const EXPECTED_DAILY_COLUMNS = [
  'day_utc', 'outcome', 'requests', 'input_tokens_known', 'input_tokens_unavailable',
  'cost_provider_usd', 'cost_estimate_usd', 'cost_unavailable', 'cap_accrued_usd',
];
const UPSTREAM_STAGE = [
  'timeout', 'rate_limited', 'upstream_overloaded', 'auth_error', 'upstream_billing',
  'unavailable_model', 'upstream_rejected', 'upstream_error', 'invalid_response',
];
const EXPECTED_AGGREGATE_ONLY = [
  'disabled', 'not_configured', 'invalid_request', 'payload_too_large',
  'sensitive_goal', 'busy', 'spend_cap_reached', 'server_error',
];

// Strings planted in row keys that recordDecision must never persist.
const MARKERS = {
  goal: 'MARKER-GOAL-5be1c0',
  url: 'MARKER-URL-0a9e44',
  origin: 'MARKER-ORIGIN-77d2f1',
  title: 'MARKER-TITLE-3c80aa',
  text: 'MARKER-TEXT-e61b29',
  label: 'MARKER-LABEL-d4f803',
  elementId: 'MARKER-ELEMENT-ID-92c7be',
  hashKey: 'a'.repeat(64),
  ip: '203.0.113.77',
};

function freshDb() {
  const db = new Database(':memory:');
  const originalLog = console.log;
  console.log = () => {};
  try {
    initializeDatabase(db);
  } finally {
    console.log = originalLog;
  }
  return db;
}

function baseRow(over = {}) {
  return Object.assign({
    decisionId: 'd-0001',
    createdAtMs: NOW,
    outcome: 'ok',
    servedModel: 'typesafe/jev-1.13-20260901',
    instrumentVersion: 'fsb-jev-instrument-1',
    calibrationStatus: 'calibrated',
    kinds: ['target', 'operation'],
    elementCount: 12,
    requestBytes: 3456,
    inputTokens: 1234,
    usageSource: 'provider',
    costUsd: 0.000123,
    costSource: 'provider',
    upstreamLatencyMs: 420,
    gatewayLatencyMs: 455,
    upstreamStatus: 200,
    hashKeyPresent: true,
  }, over);
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function decisionCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM jev_decisions').get().n;
}
function dailySnapshot(db) {
  return db.prepare('SELECT * FROM jev_daily ORDER BY day_utc, outcome').all();
}
function dailyRow(db, dayUtc, outcome) {
  return db.prepare('SELECT * FROM jev_daily WHERE day_utc = ? AND outcome = ?').get(dayUtc, outcome);
}
function allCells(db, table) {
  return db.prepare(`SELECT * FROM ${table}`).all()
    .map((row) => Object.values(row).map((v) => String(v)).join('|'))
    .join('\n');
}
function throwsTypeError(fn) {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}

// ---------------------------------------------------------------------------

function schemaSection(ledger) {
  console.log('\n--- Schema: jev_decisions and jev_daily ---');
  const db = freshDb();
  const decisionCols = tableColumns(db, 'jev_decisions');
  const dailyCols = tableColumns(db, 'jev_daily');
  check('jev_decisions has exactly the interface columns', deepEqual(decisionCols, EXPECTED_DECISION_COLUMNS), show(decisionCols));
  check('jev_daily has exactly the interface columns', deepEqual(dailyCols, EXPECTED_DAILY_COLUMNS), show(dailyCols));
  if (ledger) {
    check('LEDGER_COLUMNS equals the jev_decisions columns', deepEqual([...ledger.LEDGER_COLUMNS], decisionCols), show(ledger.LEDGER_COLUMNS));
    check('LEDGER_COLUMNS is frozen', Object.isFrozen(ledger.LEDGER_COLUMNS));
  }

  const forbiddenTokens = ['goal', 'url', 'origin', 'title', 'text', 'label', 'ip'];
  for (const [table, cols] of [['jev_decisions', decisionCols], ['jev_daily', dailyCols]]) {
    const offenders = cols.filter((name) => {
      const tokens = name.split('_');
      if (tokens.some((t) => forbiddenTokens.includes(t))) return true;
      if (forbiddenTokens.slice(0, 6).some((word) => name.includes(word))) return true;
      if (name.includes('element_id')) return true;
      if (name.includes('hash_key') && name !== 'hash_key_present') return true;
      return false;
    });
    check(`${table}: no column can hold a goal, URL, origin, title, text, label, element id, hash key or IP`, offenders.length === 0, show(offenders));
  }
  check('hash_key_present is the only hash column', decisionCols.filter((c) => c.includes('hash')).join(',') === 'hash_key_present');

  const notNull = Object.fromEntries(db.prepare('PRAGMA table_info(jev_decisions)').all().map((c) => [c.name, c.notnull === 1]));
  for (const col of ['input_tokens', 'cost_usd', 'served_model', 'instrument_version', 'calibration_status', 'upstream_latency_ms', 'upstream_status']) {
    check(`jev_decisions.${col} is nullable`, notNull[col] === false);
  }
  for (const col of ['decision_id', 'created_at', 'day_utc', 'outcome', 'kinds', 'element_count', 'request_bytes', 'usage_source', 'cost_source', 'gateway_latency_ms', 'hash_key_present']) {
    check(`jev_decisions.${col} is NOT NULL`, notNull[col] === true);
  }

  const index = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_jev_decisions_created_at'").get();
  check('idx_jev_decisions_created_at exists on jev_decisions', !!index && index.tbl_name === 'jev_decisions', show(index));
  const indexCols = db.prepare('PRAGMA index_info(idx_jev_decisions_created_at)').all().map((c) => c.name);
  check('idx_jev_decisions_created_at covers created_at', deepEqual(indexCols, ['created_at']), show(indexCols));

  const uniqueDaily = db.prepare('PRAGMA index_list(jev_daily)').all().filter((i) => i.unique === 1)
    .map((i) => db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map((c) => c.name));
  check('jev_daily is UNIQUE(day_utc, outcome)', uniqueDaily.some((cols) => deepEqual(cols, ['day_utc', 'outcome'])), show(uniqueDaily));

  const masterBefore = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'jev%' AND name NOT LIKE 'idx_jev%' ORDER BY type, name").all();
  let secondThrew = false;
  const originalLog = console.log;
  console.log = () => {};
  try {
    initializeDatabase(db);
  } catch (_e) {
    secondThrew = true;
  } finally {
    console.log = originalLog;
  }
  check('initializeDatabase is idempotent (second call does not throw)', !secondThrew);
  const masterAfter = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'jev%' AND name NOT LIKE 'idx_jev%' ORDER BY type, name").all();
  check('existing tables and indexes are unchanged by a second initializeDatabase', deepEqual(masterBefore, masterAfter));
  const existing = new Set(masterBefore.filter((r) => r.type === 'table').map((r) => r.name));
  for (const table of ['hash_keys', 'agents', 'agent_runs', 'pairing_tokens', 'telemetry_events', 'telemetry_rollups_daily', 'telemetry_global_aggregates', 'telemetry_daily_salt', 'github_cache']) {
    check(`existing table ${table} still exists`, existing.has(table));
  }
  check('no existing table definition mentions jev', masterBefore.every((r) => !String(r.sql || '').toLowerCase().includes('jev')));
  check('the jev tables survive a second initializeDatabase', deepEqual(tableColumns(db, 'jev_decisions'), EXPECTED_DECISION_COLUMNS));
}

function recordDecisionSection(ledger) {
  console.log('\n--- recordDecision: one transactional, body-free write ---');
  const db = freshDb();

  // ok row with provider tokens and provider cost.
  ledger.recordDecision(db, baseRow({ decisionId: 'd-provider' }), { capUsd: 0.000123 });
  const provider = db.prepare('SELECT * FROM jev_decisions WHERE decision_id = ?').get('d-provider');
  check('provider row stored', !!provider);
  check('provider row: created_at and day_utc', provider && provider.created_at === NOW && provider.day_utc === TODAY, show(provider));
  check('provider row: outcome ok', provider && provider.outcome === 'ok');
  check('provider row: served model stored verbatim', provider && provider.served_model === 'typesafe/jev-1.13-20260901');
  check('provider row: instrument version and calibration status', provider && provider.instrument_version === 'fsb-jev-instrument-1' && provider.calibration_status === 'calibrated');
  check('provider row: kinds sorted and joined with ","', provider && provider.kinds === 'operation,target', provider && provider.kinds);
  check('provider row: element count and request bytes', provider && provider.element_count === 12 && provider.request_bytes === 3456);
  check('provider row: provider tokens kept with their source', provider && provider.input_tokens === 1234 && provider.usage_source === 'provider');
  check('provider row: provider cost kept with its source', provider && approx(provider.cost_usd, 0.000123) && provider.cost_source === 'provider');
  check('provider row: latencies and upstream status', provider && provider.upstream_latency_ms === 420 && provider.gateway_latency_ms === 455 && provider.upstream_status === 200);
  check('provider row: hash_key_present stored as 1', provider && provider.hash_key_present === 1);
  const okDaily = dailyRow(db, TODAY, 'ok');
  check('daily (today, ok): requests 1', okDaily && okDaily.requests === 1, show(okDaily));
  check('daily (today, ok): known input tokens summed', okDaily && okDaily.input_tokens_known === 1234 && okDaily.input_tokens_unavailable === 0);
  check('daily (today, ok): provider cost summed', okDaily && approx(okDaily.cost_provider_usd, 0.000123) && okDaily.cost_estimate_usd === 0 && okDaily.cost_unavailable === 0);
  check('daily (today, ok): cap accrual recorded', okDaily && approx(okDaily.cap_accrued_usd, 0.000123));

  // estimate row.
  ledger.recordDecision(db, baseRow({
    decisionId: 'd-estimate', costUsd: 0.0000617, costSource: 'estimate', hashKeyPresent: false,
    servedModel: 'jev-1.13.0', kinds: ['completion'],
  }), { capUsd: 0.0000617 });
  const estimate = db.prepare('SELECT * FROM jev_decisions WHERE decision_id = ?').get('d-estimate');
  check('estimate row: cost_source estimate', estimate && estimate.cost_source === 'estimate' && approx(estimate.cost_usd, 0.0000617), show(estimate));
  check('estimate row: hash_key_present stored as 0', estimate && estimate.hash_key_present === 0);
  check('estimate row: single kind stored as is', estimate && estimate.kinds === 'completion');
  const okDaily2 = dailyRow(db, TODAY, 'ok');
  check('two ok rows on one day: requests 2', okDaily2 && okDaily2.requests === 2, show(okDaily2));
  check('daily (today, ok): estimate cost summed separately', okDaily2 && approx(okDaily2.cost_estimate_usd, 0.0000617) && approx(okDaily2.cost_provider_usd, 0.000123));
  check('daily (today, ok): known tokens summed across rows', okDaily2 && okDaily2.input_tokens_known === 2468);
  check('daily (today, ok): cap accrual summed', okDaily2 && approx(okDaily2.cap_accrued_usd, 0.000123 + 0.0000617));

  // unavailable row: null tokens and null cost, never 0.
  ledger.recordDecision(db, baseRow({
    decisionId: 'd-unavailable', outcome: 'timeout', servedModel: null, calibrationStatus: null,
    inputTokens: null, usageSource: 'unavailable', costUsd: null, costSource: 'unavailable',
    upstreamLatencyMs: null, upstreamStatus: null,
  }), { capUsd: 0.0001 });
  const unavailable = db.prepare('SELECT * FROM jev_decisions WHERE decision_id = ?').get('d-unavailable');
  check('unavailable row: input_tokens is NULL (never 0)', unavailable && unavailable.input_tokens === null, show(unavailable));
  check('unavailable row: cost_usd is NULL (never 0)', unavailable && unavailable.cost_usd === null);
  check('unavailable row: sources are unavailable', unavailable && unavailable.usage_source === 'unavailable' && unavailable.cost_source === 'unavailable');
  check('unavailable row: served model, calibration, upstream latency and status are NULL', unavailable
    && unavailable.served_model === null && unavailable.calibration_status === null
    && unavailable.upstream_latency_ms === null && unavailable.upstream_status === null);
  const timeoutDaily = dailyRow(db, TODAY, 'timeout');
  check('daily (today, timeout): input_tokens_unavailable and cost_unavailable incremented', timeoutDaily
    && timeoutDaily.requests === 1 && timeoutDaily.input_tokens_unavailable === 1 && timeoutDaily.cost_unavailable === 1
    && timeoutDaily.input_tokens_known === 0 && timeoutDaily.cost_provider_usd === 0 && timeoutDaily.cost_estimate_usd === 0, show(timeoutDaily));
  check('daily (today, timeout): the conservative cap accrual is kept apart from cost', timeoutDaily && approx(timeoutDaily.cap_accrued_usd, 0.0001));

  // Default capUsd is 0.
  ledger.recordDecision(db, baseRow({ decisionId: 'd-nocap', outcome: 'upstream_error', upstreamStatus: 500, inputTokens: null, usageSource: 'unavailable', costUsd: null, costSource: 'unavailable' }));
  const noCap = dailyRow(db, TODAY, 'upstream_error');
  check('capUsd defaults to 0', noCap && noCap.requests === 1 && noCap.cap_accrued_usd === 0, show(noCap));

  // Unknown row keys are ignored and never persisted.
  ledger.recordDecision(db, baseRow(Object.assign({ decisionId: 'd-markers' }, MARKERS)), { capUsd: 0 });
  const cells = `${allCells(db, 'jev_decisions')}\n${allCells(db, 'jev_daily')}`;
  const leaked = Object.values(MARKERS).filter((m) => cells.includes(m));
  check('unknown row keys (goal, url, origin, title, text, label, element id, hash key, IP) are never persisted', leaked.length === 0, show(leaked));

  // createdAtMs drives the UTC day.
  ledger.recordDecision(db, baseRow({ decisionId: 'd-late', createdAtMs: Date.UTC(2026, 4, 14, 23, 59, 59, 999) }));
  ledger.recordDecision(db, baseRow({ decisionId: 'd-next', createdAtMs: Date.UTC(2026, 4, 15, 0, 0, 0, 0) }));
  const late = db.prepare('SELECT day_utc FROM jev_decisions WHERE decision_id = ?').get('d-late');
  const next = db.prepare('SELECT day_utc FROM jev_decisions WHERE decision_id = ?').get('d-next');
  check('23:59:59.999 UTC stays on its day', late && late.day_utc === '2026-05-14', show(late));
  check('00:00 UTC starts the next day', next && next.day_utc === '2026-05-15', show(next));
  check('the next day gets its own (day, ok) aggregate row', dailyRow(db, '2026-05-15', 'ok') && dailyRow(db, '2026-05-15', 'ok').requests === 1);

  console.log('\n--- recordDecision: every LEDGER_OUTCOMES member ---');
  const perOutcome = freshDb();
  ledger.LEDGER_OUTCOMES.forEach((outcome, i) => {
    ledger.recordDecision(perOutcome, baseRow({
      decisionId: `d-outcome-${i}`, outcome,
      inputTokens: null, usageSource: 'unavailable', costUsd: null, costSource: 'unavailable',
    }), { capUsd: 0.00001 });
  });
  const rows = dailySnapshot(perOutcome);
  check('one jev_daily row per (day, outcome)', rows.length === ledger.LEDGER_OUTCOMES.length, `${rows.length} rows`);
  check('each outcome row has requests 1', rows.every((r) => r.day_utc === TODAY && r.requests === 1), show(rows.map((r) => [r.outcome, r.requests])));
  check('the aggregate rows cover exactly LEDGER_OUTCOMES', deepEqual(rows.map((r) => r.outcome).sort(), [...ledger.LEDGER_OUTCOMES].sort()));
  check('one ledger row per call', decisionCount(perOutcome) === ledger.LEDGER_OUTCOMES.length);
  ledger.recordDecision(perOutcome, baseRow({ decisionId: 'd-outcome-again', outcome: 'rate_limited', inputTokens: null, usageSource: 'unavailable', costUsd: null, costSource: 'unavailable' }));
  check('a second row on the same day and outcome increments requests to 2', dailyRow(perOutcome, TODAY, 'rate_limited').requests === 2);
}

function rejectionSection(ledger) {
  console.log('\n--- recordDecision: rejects and writes nothing ---');
  const db = freshDb();
  ledger.recordDecision(db, baseRow({ decisionId: 'd-seed' }), { capUsd: 0.00005 });
  const countBefore = decisionCount(db);
  const dailyBefore = dailySnapshot(db);

  const cases = [
    ['outcome network_error (client-only)', { outcome: 'network_error' }],
    ['outcome bogus', { outcome: 'bogus' }],
    ['outcome busy (aggregate-only)', { outcome: 'busy' }],
    ['outcome invalid_request (aggregate-only)', { outcome: 'invalid_request' }],
    ['outcome spend_cap_reached (aggregate-only)', { outcome: 'spend_cap_reached' }],
    ['outcome disabled (aggregate-only)', { outcome: 'disabled' }],
    ['outcome missing', { outcome: undefined }],
    ['kinds with a non-contract member', { kinds: ['operation', 'MARKER-KINDS'] }],
    ['kinds empty', { kinds: [] }],
    ['kinds a string', { kinds: 'operation' }],
    ['kinds duplicated', { kinds: ['operation', 'operation'] }],
    ['elementCount -1', { elementCount: -1 }],
    ['elementCount 1.5', { elementCount: 1.5 }],
    ['elementCount a string', { elementCount: '12' }],
    ['requestBytes -1', { requestBytes: -1 }],
    ['requestBytes NaN', { requestBytes: NaN }],
    ['decisionId empty', { decisionId: '' }],
    ['decisionId 65 characters', { decisionId: 'd'.repeat(65) }],
    ['decisionId a number', { decisionId: 7 }],
    ['usageSource outside CONTRACT', { usageSource: 'estimate' }],
    ['costSource outside CONTRACT', { costSource: 'guess' }],
    ['usage provider with null tokens', { inputTokens: null }],
    ['usage unavailable with tokens', { usageSource: 'unavailable' }],
    ['usage unavailable with 0 tokens (null, never 0)', { usageSource: 'unavailable', inputTokens: 0 }],
    ['cost unavailable with a number (null, never 0)', { costSource: 'unavailable', costUsd: 0 }],
    ['cost provider with null', { costUsd: null }],
    ['cost negative', { costUsd: -0.1 }],
    ['calibration status outside CONTRACT', { calibrationStatus: 'MARKER-CAL' }],
    ['upstream status out of range', { upstreamStatus: 99 }],
    ['gateway latency missing', { gatewayLatencyMs: undefined }],
    ['hashKeyPresent not a boolean', { hashKeyPresent: 'yes' }],
    ['createdAtMs not a number', { createdAtMs: 'now' }],
  ];
  for (const [label, over] of cases) {
    const row = baseRow(Object.assign({ decisionId: 'd-reject' }, over));
    check(`TypeError: ${label}`, throwsTypeError(() => ledger.recordDecision(db, row, { capUsd: 1 })));
  }
  check('TypeError: row is not an object', throwsTypeError(() => ledger.recordDecision(db, null)));
  check('TypeError: capUsd negative', throwsTypeError(() => ledger.recordDecision(db, baseRow({ decisionId: 'd-reject' }), { capUsd: -1 })));
  check('TypeError: capUsd NaN', throwsTypeError(() => ledger.recordDecision(db, baseRow({ decisionId: 'd-reject' }), { capUsd: NaN })));

  check('rejected rows leave jev_decisions unchanged', decisionCount(db) === countBefore, `${decisionCount(db)} vs ${countBefore}`);
  check('rejected rows leave jev_daily unchanged', deepEqual(dailySnapshot(db), dailyBefore), show(dailySnapshot(db)));
  check('the planted kinds marker reached no cell', !`${allCells(db, 'jev_decisions')}${allCells(db, 'jev_daily')}`.includes('MARKER'));

  let messageLeak = '';
  try {
    ledger.recordDecision(db, baseRow({ decisionId: 'd-reject', kinds: ['MARKER-KINDS-MSG'] }));
  } catch (error) {
    messageLeak = String(error && error.message);
  }
  check('a TypeError message never quotes the rejected value', messageLeak !== '' && !messageLeak.includes('MARKER'), messageLeak);

  console.log('\n--- recordDecision: a failed UPSERT rolls the ledger row back ---');
  const txDb = freshDb();
  txDb.exec("CREATE TRIGGER jev_daily_fail BEFORE INSERT ON jev_daily BEGIN SELECT RAISE(ABORT, 'synthetic daily failure'); END;");
  let threw = false;
  try {
    ledger.recordDecision(txDb, baseRow({ decisionId: 'd-rollback' }), { capUsd: 0.5 });
  } catch (_e) {
    threw = true;
  }
  check('recordDecision throws when the daily UPSERT fails', threw);
  check('the ledger INSERT was rolled back (one transaction)', decisionCount(txDb) === 0, `${decisionCount(txDb)} rows`);
  check('jev_daily stays empty', dailySnapshot(txDb).length === 0);
}

function outcomeListsSection(ledger) {
  console.log('\n--- LEDGER_OUTCOMES and AGGREGATE_ONLY_OUTCOMES ---');
  check('LEDGER_OUTCOMES is frozen', Object.isFrozen(ledger.LEDGER_OUTCOMES));
  check('AGGREGATE_ONLY_OUTCOMES is frozen', Object.isFrozen(ledger.AGGREGATE_ONLY_OUTCOMES));
  check('LEDGER_OUTCOMES is ok, the upstream-stage reasons and server_error',
    deepEqual([...ledger.LEDGER_OUTCOMES], ['ok', ...UPSTREAM_STAGE, 'server_error']), show(ledger.LEDGER_OUTCOMES));
  check('AGGREGATE_ONLY_OUTCOMES is the pre-upstream reasons and server_error',
    deepEqual([...ledger.AGGREGATE_ONLY_OUTCOMES], EXPECTED_AGGREGATE_ONLY), show(ledger.AGGREGATE_ONLY_OUTCOMES));
  const intersection = ledger.LEDGER_OUTCOMES.filter((o) => ledger.AGGREGATE_ONLY_OUTCOMES.includes(o));
  check('the two lists share exactly server_error', deepEqual(intersection, ['server_error']), show(intersection));
  const union = [...new Set([...ledger.LEDGER_OUTCOMES, ...ledger.AGGREGATE_ONLY_OUTCOMES])].sort();
  check('their union is ok plus GATEWAY_FALLBACK_REASONS', deepEqual(union, ['ok', ...CONTRACT.GATEWAY_FALLBACK_REASONS].sort()), show(union));
  check('neither list holds a client-only reason', CONTRACT.CLIENT_ONLY_FALLBACK_REASONS.every((r) => !union.includes(r)));
  check('at most 18 outcomes per UTC day', union.length === 18, `${union.length}`);
}

function aggregateOnlySection(ledger) {
  console.log('\n--- recordAggregateOnly: bounded counters, no ledger rows ---');
  const db = freshDb();
  for (const outcome of ledger.AGGREGATE_ONLY_OUTCOMES) {
    ledger.recordAggregateOnly(db, { dayUtc: TODAY, outcome });
  }
  check('no ledger row for any aggregate-only outcome', decisionCount(db) === 0);
  const rows = dailySnapshot(db);
  check('one jev_daily row per aggregate-only outcome', rows.length === ledger.AGGREGATE_ONLY_OUTCOMES.length, `${rows.length}`);
  check('each row counts requests only', rows.every((r) => r.requests === 1 && r.input_tokens_known === 0
    && r.input_tokens_unavailable === 0 && r.cost_provider_usd === 0 && r.cost_estimate_usd === 0
    && r.cost_unavailable === 0 && r.cap_accrued_usd === 0), show(rows));

  const flood = freshDb();
  for (let i = 0; i < 1000; i += 1) {
    const outcome = ledger.AGGREGATE_ONLY_OUTCOMES[i % ledger.AGGREGATE_ONLY_OUTCOMES.length];
    ledger.recordAggregateOnly(flood, { dayUtc: TODAY, outcome });
  }
  const floodRows = dailySnapshot(flood).filter((r) => r.day_utc === TODAY);
  check('1,000 refused requests leave jev_decisions empty', decisionCount(flood) === 0);
  check('1,000 refused requests leave at most 8 jev_daily rows for the day', floodRows.length <= 8 && floodRows.length === ledger.AGGREGATE_ONLY_OUTCOMES.length, `${floodRows.length}`);
  check('the counters add up to 1,000', floodRows.reduce((sum, r) => sum + r.requests, 0) === 1000);

  check('TypeError: aggregate-only rejects ok', throwsTypeError(() => ledger.recordAggregateOnly(db, { dayUtc: TODAY, outcome: 'ok' })));
  check('TypeError: aggregate-only rejects an upstream-stage outcome', throwsTypeError(() => ledger.recordAggregateOnly(db, { dayUtc: TODAY, outcome: 'timeout' })));
  check('TypeError: aggregate-only rejects a client-only outcome', throwsTypeError(() => ledger.recordAggregateOnly(db, { dayUtc: TODAY, outcome: 'network_error' })));
  check('TypeError: aggregate-only rejects a malformed day', throwsTypeError(() => ledger.recordAggregateOnly(db, { dayUtc: '2026-5-14', outcome: 'busy' })));
  check('TypeError: aggregate-only rejects a missing argument', throwsTypeError(() => ledger.recordAggregateOnly(db)));
  check('rejected aggregate calls changed nothing', deepEqual(dailySnapshot(db), rows));

  console.log('\n--- server_error on both paths shares one (day, server_error) row ---');
  const both = freshDb();
  ledger.recordAggregateOnly(both, { dayUtc: TODAY, outcome: 'server_error' });
  ledger.recordDecision(both, baseRow({
    decisionId: 'd-post-upstream', outcome: 'server_error', calibrationStatus: null,
    inputTokens: null, usageSource: 'unavailable', costUsd: null, costSource: 'unavailable',
    upstreamLatencyMs: null, upstreamStatus: null,
  }), { capUsd: 0.00002 });
  check('one jev_decisions row', decisionCount(both) === 1);
  const serverDaily = dailySnapshot(both);
  check('one jev_daily row for (day, server_error)', serverDaily.length === 1 && serverDaily[0].outcome === 'server_error', show(serverDaily));
  check('requests 2 and cap_accrued_usd 0.00002', serverDaily[0] && serverDaily[0].requests === 2 && approx(serverDaily[0].cap_accrued_usd, 0.00002), show(serverDaily[0]));
  check('todaySpendUsd includes the post-upstream accrual', approx(ledger.todaySpendUsd(both, TODAY), 0.00002), show(ledger.todaySpendUsd(both, TODAY)));
}

function spendSection(ledger) {
  console.log('\n--- todaySpendUsd ---');
  const db = freshDb();
  check('todaySpendUsd is 0 for an empty day', ledger.todaySpendUsd(db, TODAY) === 0);
  ledger.recordDecision(db, baseRow({ decisionId: 's-1' }), { capUsd: 0.25 });
  ledger.recordDecision(db, baseRow({ decisionId: 's-2', outcome: 'timeout', inputTokens: null, usageSource: 'unavailable', costUsd: null, costSource: 'unavailable' }), { capUsd: 0.5 });
  ledger.recordDecision(db, baseRow({ decisionId: 's-3', createdAtMs: NOW - ONE_DAY_MS }), { capUsd: 4 });
  ledger.recordAggregateOnly(db, { dayUtc: TODAY, outcome: 'busy' });
  check('todaySpendUsd sums the cap accrual across outcomes for the day', approx(ledger.todaySpendUsd(db, TODAY), 0.75), show(ledger.todaySpendUsd(db, TODAY)));
  check('todaySpendUsd keeps days apart', approx(ledger.todaySpendUsd(db, '2026-05-13'), 4));
  check('todaySpendUsd is 0 for a day with no rows', ledger.todaySpendUsd(db, '2026-05-16') === 0);
  check('TypeError: todaySpendUsd rejects a malformed day', throwsTypeError(() => ledger.todaySpendUsd(db, 'today')));
}

function dayKeySection(ledger) {
  console.log('\n--- dayUtcKey ---');
  check('dayUtcKey formats the UTC day', ledger.dayUtcKey(NOW) === TODAY);
  check('dayUtcKey uses UTC at the day edge', ledger.dayUtcKey(Date.UTC(2026, 0, 1, 0, 0, 0)) === '2026-01-01'
    && ledger.dayUtcKey(Date.UTC(2025, 11, 31, 23, 59, 59, 999)) === '2025-12-31');
}

function pruneSection(ledger) {
  console.log('\n--- pruneJevLedger: 7-day ledger, 365-day aggregate ---');
  const db = freshDb();
  const seven = 7 * ONE_DAY_MS;
  ledger.recordDecision(db, baseRow({ decisionId: 'p-old', createdAtMs: NOW - seven - 1 }));
  ledger.recordDecision(db, baseRow({ decisionId: 'p-edge', createdAtMs: NOW - seven }));
  ledger.recordDecision(db, baseRow({ decisionId: 'p-new', createdAtMs: NOW - ONE_DAY_MS }));
  const keptDay = ledger.dayUtcKey(NOW - 365 * ONE_DAY_MS);
  const goneDay = ledger.dayUtcKey(NOW - 366 * ONE_DAY_MS);
  ledger.recordAggregateOnly(db, { dayUtc: keptDay, outcome: 'busy' });
  ledger.recordAggregateOnly(db, { dayUtc: goneDay, outcome: 'busy' });
  ledger.recordAggregateOnly(db, { dayUtc: '2024-01-01', outcome: 'disabled' });
  ledger.pruneJevLedger(db, NOW);
  const ids = db.prepare('SELECT decision_id FROM jev_decisions ORDER BY decision_id').all().map((r) => r.decision_id);
  check('ledger rows older than 7 days are deleted', !ids.includes('p-old'), show(ids));
  check('ledger rows exactly 7 days old and newer are kept', ids.includes('p-edge') && ids.includes('p-new'), show(ids));
  const days = db.prepare('SELECT DISTINCT day_utc FROM jev_daily ORDER BY day_utc').all().map((r) => r.day_utc);
  check('the aggregate for the day 365 days back is kept', days.includes(keptDay), show(days));
  check('aggregates older than 365 days are deleted', !days.includes(goneDay) && !days.includes('2024-01-01'), show(days));
  check('aggregates for pruned ledger rows survive the 7-day prune', days.includes(ledger.dayUtcKey(NOW - seven - 1)), show(days));
  let threw = false;
  try { ledger.pruneJevLedger(db, NOW); } catch (_e) { threw = true; }
  check('pruneJevLedger is idempotent', !threw && decisionCount(db) === 2);
  const bare = new Database(':memory:');
  check('pruneJevLedger throws on a database without the jev tables (the housekeeper guards it)', (() => {
    try { ledger.pruneJevLedger(bare, NOW); return false; } catch (_e) { return true; }
  })());
}

function formatLogSection(ledger) {
  console.log('\n--- formatDecisionLog ---');
  const row = baseRow(Object.assign({ decisionId: 'd-log-1' }, MARKERS, { goal: 'SECRET-GOAL' }));
  const line = ledger.formatDecisionLog(row);
  check('the line starts with "[jev] decision "', typeof line === 'string' && line.startsWith('[jev] decision '), show(line));
  check('the line is a single line', typeof line === 'string' && !line.includes('\n'));
  let payload = null;
  try { payload = JSON.parse(String(line).slice('[jev] decision '.length)); } catch (_e) { payload = null; }
  const expectedKeys = ['decisionId', 'outcome', 'kinds', 'elements', 'bytes', 'servedModel', 'calibration',
    'inputTokens', 'usageSource', 'costUsd', 'costSource', 'upstreamMs', 'gatewayMs', 'upstreamStatus', 'hashKeyPresent'];
  check('the payload holds exactly the allowlisted keys in order', payload && deepEqual(Object.keys(payload), expectedKeys), show(payload && Object.keys(payload)));
  check('decisionId comes first', payload && Object.keys(payload)[0] === 'decisionId' && payload.decisionId === 'd-log-1');
  check('the payload values come from the row', payload && payload.outcome === 'ok' && payload.elements === 12 && payload.bytes === 3456
    && payload.servedModel === 'typesafe/jev-1.13-20260901' && payload.calibration === 'calibrated'
    && payload.inputTokens === 1234 && payload.usageSource === 'provider' && approx(payload.costUsd, 0.000123)
    && payload.costSource === 'provider' && payload.upstreamMs === 420 && payload.gatewayMs === 455
    && payload.upstreamStatus === 200 && payload.hashKeyPresent === true, show(payload));
  check('kinds are listed sorted', payload && deepEqual(payload.kinds, ['operation', 'target']), show(payload && payload.kinds));
  check('extra row keys never appear (SECRET-GOAL)', !String(line).includes('SECRET-GOAL'));
  const leaked = Object.values(MARKERS).filter((m) => String(line).includes(m));
  check('no planted marker appears in the line', leaked.length === 0, show(leaked));

  const unknownLine = ledger.formatDecisionLog(baseRow({
    decisionId: 'd-log-2', inputTokens: null, usageSource: 'unavailable', costUsd: null, costSource: 'unavailable',
    servedModel: null, calibrationStatus: null, upstreamLatencyMs: null, upstreamStatus: null, hashKeyPresent: false,
  }));
  let unknown = null;
  try { unknown = JSON.parse(String(unknownLine).slice('[jev] decision '.length)); } catch (_e) { unknown = null; }
  check('unknown usage and cost stay null in the line (never 0)', unknown && unknown.inputTokens === null && unknown.costUsd === null
    && unknown.servedModel === null && unknown.hashKeyPresent === false, show(unknown));

  const hostile = ledger.formatDecisionLog(baseRow({
    decisionId: 'd-log-3', kinds: ['operation', 'MARKER-KINDS-LOG'], outcome: 'MARKER-OUTCOME',
    calibrationStatus: 'MARKER-CAL', usageSource: 'MARKER-USAGE', costSource: 'MARKER-COST',
    servedModel: 'bad model with spaces MARKER-MODEL',
  }));
  check('values outside the contract never reach the line', typeof hostile === 'string' && !hostile.includes('MARKER'), show(hostile));
  let nonObject = '';
  try { nonObject = ledger.formatDecisionLog(null); } catch (_e) { nonObject = 'threw'; }
  check('formatDecisionLog never throws on a non-object row', typeof nonObject === 'string' && nonObject.startsWith('[jev] decision '), nonObject);
}

function staticSection() {
  console.log('\n--- Static: ledger.js never logs ---');
  const fs = require('fs');
  const source = fs.readFileSync(path.join(JEV_DIR, 'ledger.js'), 'utf8');
  check('ledger.js has no console call', !/console\./.test(source));
  check('ledger.js never reads err.message', !/err\.message|error\.message|\.stack\b/.test(source));
  check('ledger.js validates outcomes against GATEWAY_FALLBACK_REASONS', source.includes('GATEWAY_FALLBACK_REASONS'));
}

function main() {
  const ledger = loadModule('ledger.js');
  schemaSection(ledger);
  if (ledger) {
    recordDecisionSection(ledger);
    rejectionSection(ledger);
    outcomeListsSection(ledger);
    aggregateOnlySection(ledger);
    spendSection(ledger);
    dayKeySection(ledger);
    pruneSection(ledger);
    formatLogSection(ledger);
    staticSection();
  }
  console.log(`\n=== jev-gateway-ledger results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

try {
  main();
} catch (error) {
  console.log(`  FAIL: suite crashed -- ${error && error.name}`);
  console.log(`\n=== jev-gateway-ledger results: ${passed} passed, ${failed + 1} failed ===`);
  process.exit(1);
}
