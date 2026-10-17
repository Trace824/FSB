/**
 * Phase 67 / JEV-01, JEV-02, JEV-06, JEV-07 -- FsbJevClient, the extension's
 * never-rejecting Jev decision client (extension/ai/jev-client.js).
 *
 * Every test injects fetchImpl through createJevClient, so no test makes a
 * live network call. The few cases that exercise the lazy globalThis.fetch
 * lookup swap in a fake and restore the original afterwards.
 *
 * Run: node tests/jev-client.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CLIENT_PATH = path.join(ROOT, 'extension', 'ai', 'jev-client.js');
const S = require('../extension/ai/jev-state.js');

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
  let text;
  try { text = JSON.stringify(value); } catch (_e) { text = String(value); }
  return text && text.length > 400 ? `${text.slice(0, 400)}...` : text;
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const ENDPOINT = 'https://full-selfbrowsing.com/api/jev/decide';
const TEST_ENDPOINT = 'http://127.0.0.1:9/api/jev/decide';
const HASH_KEY = '0123456789abcdef'.repeat(4);
const CARD_GOAL = 'Pay with 4111 1111 1111 1111 today';
const KEY_GOAL = 'Use the key sk-ant-abcdefghijklmnop1234 to sign in';

let C = null;

// ---------------------------------------------------------------------------
// Fixtures (built with FsbJevState-valid fields)
// ---------------------------------------------------------------------------

function validRequest() {
  return {
    v: 1,
    kinds: ['operation', 'target', 'risk'],
    goal: 'Save the checklist',
    page: { origin: 'https://example.test', path: '/checklist', title: 'Checklist', text: 'Alpha' },
    elements: [
      { id: 'e0', role: 'checkbox', label: 'Alpha', ops: ['check_box', 'click'] },
      { id: 'e1', role: 'button', label: 'Save', ops: ['click'] },
    ],
    recentActions: [],
    offeredOps: ['click', 'check_box', 'scroll'],
    proposedAction: { op: 'click', targetId: 'e1' },
  };
}

function allKindsRequest() {
  const request = validRequest();
  request.kinds = S.CONTRACT.KINDS.slice();
  return request;
}

function okBody() {
  return {
    ok: true,
    decisionId: 'jd_0123456789abcdef',
    instrumentVersion: 'fsb-jev-1',
    servedModel: 'typesafe/jev-1.13',
    calibration: { status: 'uncalibrated', profileId: 'uncalibrated' },
    decisions: {
      operation: {
        choice: 'click', confidence: 0.8,
        probabilities: { click: 0.8, check_box: 0.05, scroll: 0.05, none_of_the_above: 0.1 },
        threshold: null, meetsThreshold: false,
      },
      target: {
        choice: 'e1', confidence: 0.7,
        probabilities: { e0: 0.2, e1: 0.7, none_of_the_above: 0.1 },
        threshold: null, meetsThreshold: false,
      },
      risk: { p: 0.1, threshold: null, meetsThreshold: false },
    },
    usage: { inputTokens: 1234, source: 'provider' },
    cost: { usd: 0.00031, source: 'provider' },
    latencyMs: 412,
  };
}

function calibratedBody() {
  const body = okBody();
  body.calibration = { status: 'calibrated', profileId: 'p-2026-10' };
  body.decisions.operation.threshold = 0.6;
  body.decisions.operation.meetsThreshold = true;
  body.decisions.target.threshold = 0.9;
  body.decisions.risk.threshold = 0.5;
  return body;
}

function allKindsBody() {
  const body = okBody();
  body.decisions.completion = { p: 0.4, threshold: null, meetsThreshold: false };
  body.decisions.stuck = { p: 0, threshold: null, meetsThreshold: false };
  return body;
}

function fallbackBody(reason, status, servedModel) {
  return { ok: false, fallback: reason, servedModel: servedModel === undefined ? null : servedModel, httpStatus: status, latencyMs: 2 };
}

/** A schema-valid request whose JSON is over the 49,152-byte inbound cap. */
function oversizeRequest() {
  const label = '注'.repeat(S.CONTRACT.CAPS.labelChars);
  const elements = [];
  for (let i = 0; i < S.CONTRACT.CAPS.elements; i += 1) {
    elements.push({ id: `e${i}`, role: 'button', label, ops: ['click'] });
  }
  return {
    v: 1,
    kinds: ['operation', 'target'],
    goal: 'Pick the right button',
    page: { origin: 'https://example.test', path: '/', title: 'Buttons', text: '注'.repeat(S.CONTRACT.CAPS.textChars) },
    elements,
    recentActions: [],
    offeredOps: ['click'],
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function response(status, text) {
  return { status, text: async () => text };
}
function jsonResponse(status, body) {
  return response(status, JSON.stringify(body));
}

/** A fake fetch that records every call and answers through handler(url, init, n). */
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = function fakeFetch(url, init) {
    calls.push({ url, init, argc: arguments.length });
    return handler(url, init, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function manualClock(start) {
  const clock = { t: start === undefined ? 1700000000000 : start };
  clock.now = () => clock.t;
  return clock;
}

/** One decide() on a fresh client; the fake advances the clock by `latency` ms. */
async function runOnce(answer, options) {
  const opts = options || {};
  const clock = manualClock();
  const latency = opts.latency === undefined ? 37 : opts.latency;
  const fetchImpl = makeFetch(async () => {
    clock.t += latency;
    return typeof answer === 'function' ? answer() : answer;
  });
  const client = C.createJevClient(Object.assign({ fetchImpl, endpoint: TEST_ENDPOINT, now: clock.now }, opts.client || {}));
  const request = opts.request === undefined ? validRequest() : opts.request;
  const result = await client.decide(request, opts.call);
  return { result, fetchImpl, clock, client };
}

function fallbackOf(reason, httpStatus, latencyMs, servedModel) {
  return { ok: false, fallback: reason, servedModel: servedModel === undefined ? null : servedModel, httpStatus, latencyMs };
}

function isExactFallback(result) {
  return result !== null && typeof result === 'object'
    && deepEqual(Object.keys(result), S.CONTRACT.KEYS.fallbackResponse)
    && result.ok === false
    && S.CONTRACT.FALLBACK_REASONS.includes(result.fallback)
    && (result.servedModel === null || (typeof result.servedModel === 'string' && result.servedModel.length > 0))
    && (result.httpStatus === null || (Number.isInteger(result.httpStatus) && result.httpStatus >= 100 && result.httpStatus <= 599))
    && typeof result.latencyMs === 'number' && Number.isFinite(result.latencyMs) && result.latencyMs >= 0;
}

/** The result is one of the two exact D-15 shapes (an ok result re-validates against its request). */
function isExactResult(result, request) {
  if (result !== null && typeof result === 'object' && result.ok === true) {
    if (!deepEqual(Object.keys(result), S.CONTRACT.KEYS.okResponse)) return false;
    const recheck = S.validateGatewayResponse(clone(result), request);
    return recheck.ok === true;
  }
  return isExactFallback(result);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function loadSection() {
  console.log('\n--- module load and API (D-15, D-17) ---');
  try {
    C = require(CLIENT_PATH);
  } catch (error) {
    check('extension/ai/jev-client.js loads under Node', false, error && error.message);
    return false;
  }
  check('module.exports has exactly the documented API',
    deepEqual(Object.keys(C).sort(), ['COOLDOWN_MS', 'DEFAULT_TIMEOUT_MS', 'ENDPOINT', 'MAX_SPEND_COOLDOWN_MS', 'createJevClient', 'decide']),
    show(Object.keys(C)));
  check('ENDPOINT is the fixed FSB gateway URL', C.ENDPOINT === ENDPOINT, C.ENDPOINT);
  check('DEFAULT_TIMEOUT_MS is 2500', C.DEFAULT_TIMEOUT_MS === 2500);
  check('COOLDOWN_MS is 60000', C.COOLDOWN_MS === 60000);
  check('MAX_SPEND_COOLDOWN_MS is 3600000', C.MAX_SPEND_COOLDOWN_MS === 3600000);
  check('createJevClient and decide are functions', typeof C.createJevClient === 'function' && typeof C.decide === 'function');
  check('globalThis.FsbJevClient is the same api object', globalThis.FsbJevClient === C);
  const client = C.createJevClient({ fetchImpl: () => { throw new Error('must not be called'); } });
  check('createJevClient() returns a decide function', client && typeof client.decide === 'function');
  return true;
}

function staticSection() {
  console.log('\n--- static source rules (D-01, D-09, D-17) ---');
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  check('the endpoint literal appears exactly once', source.split(ENDPOINT).length - 1 === 1);
  check('no other https:// URL appears', (source.match(/https:\/\//g) || []).length === 1);
  const forbidden = /systemone|api\.typesafe\.ai|chrome\.storage|serverUrl|keepalive|AbortSignal\.any|importScripts|JEV_/;
  check('no forbidden token (upstream, storage, Sync serverUrl, keepalive, AbortSignal.any, importScripts, JEV_)',
    !forbidden.test(source), (source.match(forbidden) || [])[0]);
  check("credentials: 'omit' is in the source", /credentials: ?'omit'/.test(source));
  check('no top-level const, let or class', !/^(const|let|class) /m.test(source));
  check('no console use (the client never logs)', !/console\./.test(source));
  check('wrapped in the initFsbJevClient IIFE',
    /\(function initFsbJevClient\(root\) \{/.test(source)
    && source.includes("})(typeof globalThis !== 'undefined' ? globalThis : self);"));
}

async function okSection() {
  console.log('\n--- ok bodies (D-15) ---');
  const { result, fetchImpl } = await runOnce(jsonResponse(200, okBody()));
  const expected = Object.assign(okBody(), { latencyMs: 37 });
  check('a valid ok body returns the ok shape with the client-measured latency', deepEqual(result, expected), show(result));
  check('ok result keys are exactly KEYS.okResponse in order', deepEqual(Object.keys(result), S.CONTRACT.KEYS.okResponse));
  check('the ok result re-validates against its request', isExactResult(result, validRequest()));
  check('one fetch call was made', fetchImpl.calls.length === 1);

  const calibrated = await runOnce(jsonResponse(200, calibratedBody()), { latency: 5 });
  check('a calibrated body passes through', deepEqual(calibrated.result, Object.assign(calibratedBody(), { latencyMs: 5 })),
    show(calibrated.result));

  const allKinds = await runOnce(jsonResponse(200, allKindsBody()), { request: allKindsRequest(), latency: 0 });
  check('all five kinds pass through when all five were requested',
    deepEqual(allKinds.result, Object.assign(allKindsBody(), { latencyMs: 0 })), show(allKinds.result));

  const unavailable = Object.assign(okBody(), {
    usage: { inputTokens: null, source: 'unavailable' }, cost: { usd: null, source: 'unavailable' },
  });
  const nulls = await runOnce(jsonResponse(200, unavailable), { latency: 1 });
  check('null usage and cost marked unavailable pass through (never 0)',
    deepEqual(nulls.result, Object.assign(clone(unavailable), { latencyMs: 1 })), show(nulls.result));

  const request = validRequest();
  const before = clone(request);
  await runOnce(jsonResponse(200, okBody()), { request });
  check('decide does not mutate the request', deepEqual(request, before));
}

async function fallbackBodySection() {
  console.log('\n--- typed fallback bodies, body first (D-15, D-16) ---');
  const disabled = await runOnce(jsonResponse(503, fallbackBody('disabled', 503)), { latency: 11 });
  check('503 {fallback:disabled} maps to disabled with the received status',
    deepEqual(disabled.result, fallbackOf('disabled', 503, 11)), show(disabled.result));
  check('fallback result keys are exactly KEYS.fallbackResponse in order',
    deepEqual(Object.keys(disabled.result), S.CONTRACT.KEYS.fallbackResponse));

  for (const reason of S.CONTRACT.GATEWAY_FALLBACK_REASONS) {
    const status = S.CONTRACT.HTTP_STATUS_BY_REASON[reason];
    const { result } = await runOnce(jsonResponse(status, fallbackBody(reason, status)), { latency: 3 });
    check(`gateway body ${reason} at ${status} maps to ${reason}`, deepEqual(result, fallbackOf(reason, status, 3)), show(result));
  }

  const served = await runOnce(jsonResponse(502, fallbackBody('auth_error', 502, 'typesafe/jev-1.13-20261001')), { latency: 4 });
  check('a fallback body keeps its servedModel',
    deepEqual(served.result, fallbackOf('auth_error', 502, 4, 'typesafe/jev-1.13-20261001')), show(served.result));

  const bodyFirst = await runOnce(jsonResponse(429, fallbackBody('upstream_error', 502)), { latency: 2 });
  check('the body wins over the status (429 + upstream_error body -> upstream_error)',
    deepEqual(bodyFirst.result, fallbackOf('upstream_error', 429, 2)), show(bodyFirst.result));
  const busyAt200 = await runOnce(jsonResponse(200, fallbackBody('busy', 503)), { latency: 2 });
  check('a typed busy body at 200 maps to busy with httpStatus 200',
    deepEqual(busyAt200.result, fallbackOf('busy', 200, 2)), show(busyAt200.result));
}

async function malformedBodySection() {
  console.log('\n--- unknown, approval-like or inconsistent bodies fall to the status table (D-15, D-29) ---');
  const cases = [
    ['an extra authorize key', 200, () => Object.assign(okBody(), { authorize: true }), 'invalid_response'],
    ['an extra skipConfirmation key', 200, () => Object.assign(okBody(), { skipConfirmation: true }), 'invalid_response'],
    ['an extra approved key', 200, () => Object.assign(okBody(), { approved: true }), 'invalid_response'],
    ['an approved key inside a decision', 200, () => { const b = okBody(); b.decisions.risk.approved = true; return b; }, 'invalid_response'],
    ['a decisions key set larger than request.kinds', 200,
      () => { const b = okBody(); b.decisions.stuck = { p: 0.5, threshold: null, meetsThreshold: false }; return b; }, 'invalid_response'],
    ['a decisions key set smaller than request.kinds', 200, () => { const b = okBody(); delete b.decisions.risk; return b; }, 'invalid_response'],
    ['meetsThreshold true while uncalibrated', 200,
      () => { const b = okBody(); b.decisions.operation.threshold = 0.5; b.decisions.operation.meetsThreshold = true; return b; }, 'invalid_response'],
    ['a probability key the request never offered', 200,
      () => { const b = okBody(); b.decisions.target.probabilities.e9 = 0; return b; }, 'invalid_response'],
    ['ok true with a fallback shape', 200, () => ({ ok: true, fallback: 'busy', servedModel: null, httpStatus: 200, latencyMs: 1 }), 'invalid_response'],
    ['a client-only network_error fallback at 502', 502, () => fallbackBody('network_error', 502), 'server_error'],
    ['a client-only network_error fallback at 200', 200, () => fallbackBody('network_error', 200), 'invalid_response'],
    ['a client-only aborted fallback at 503', 503, () => fallbackBody('aborted', 503), 'server_error'],
    ['an unknown fallback reason at 429', 429, () => fallbackBody('approved', 429), 'rate_limited'],
    ['a fallback body with an extra approved key at 503', 503, () => Object.assign(fallbackBody('busy', 503), { approved: true }), 'server_error'],
    ['a fallback body with an extra skipConfirmation key at 413', 413,
      () => Object.assign(fallbackBody('payload_too_large', 413), { skipConfirmation: true }), 'payload_too_large'],
    ['an ok body with an extra key at 400', 400, () => Object.assign(okBody(), { override: 1 }), 'invalid_request'],
  ];
  for (const [label, status, makeBody, reason] of cases) {
    const { result } = await runOnce(jsonResponse(status, makeBody()), { latency: 6 });
    check(`${label} -> ${reason}`, deepEqual(result, fallbackOf(reason, status, 6)), show(result));
  }
}

async function statusTableSection() {
  console.log('\n--- status-only table, body missing or not JSON (D-16) ---');
  const rows = [
    [502, '<html>bad gateway</html>', 'server_error'],
    [504, '', 'timeout'],
    [413, '', 'payload_too_large'],
    [413, '<html>too large</html>', 'payload_too_large'],
    [429, 'slow down', 'rate_limited'],
    [400, '', 'invalid_request'],
    [404, '<html>not found</html>', 'invalid_request'],
    [451, '{}', 'invalid_request'],
    [200, 'garbage', 'invalid_response'],
    [200, '', 'invalid_response'],
    [204, '', 'invalid_response'],
    [299, 'null', 'invalid_response'],
    [200, '[]', 'invalid_response'],
    [200, '42', 'invalid_response'],
    [200, '"ok"', 'invalid_response'],
    [500, '', 'server_error'],
    [503, '<html>', 'server_error'],
    [599, '[]', 'server_error'],
    [101, '', 'invalid_response'],
    [301, '', 'invalid_response'],
    [399, '{"ok":true}', 'invalid_response'],
  ];
  for (const [status, text, reason] of rows) {
    const { result } = await runOnce(response(status, text), { latency: 8 });
    check(`${status} ${JSON.stringify(text.slice(0, 24))} -> ${reason}`, deepEqual(result, fallbackOf(reason, status, 8)), show(result));
  }
  const padded = JSON.stringify(okBody()) + ' '.repeat(70000);
  const big = await runOnce(response(200, padded), { latency: 1 });
  check('an oversized body (over 64 KiB of text) is not parsed and maps by status',
    deepEqual(big.result, fallbackOf('invalid_response', 200, 1)), show(big.result));
}

async function transportSection() {
  console.log('\n--- transport (D-09, JEV-01, JEV-02) ---');
  const request = validRequest();
  const { result, fetchImpl } = await runOnce(jsonResponse(200, okBody()), { request });
  check('the decision succeeded', result.ok === true, show(result));
  const call = fetchImpl.calls[0] || {};
  const init = call.init || {};
  check('fetch got exactly two arguments', call.argc === 2);
  check('the URL is the injected endpoint', call.url === TEST_ENDPOINT, call.url);
  check('the URL has no query string or fragment', typeof call.url === 'string' && !/[?#]/.test(call.url));
  check('init keys are exactly body, cache, credentials, headers, method, redirect, signal',
    deepEqual(Object.keys(init).sort(), ['body', 'cache', 'credentials', 'headers', 'method', 'redirect', 'signal']), show(Object.keys(init)));
  check("method is 'POST'", init.method === 'POST');
  check("credentials is 'omit'", init.credentials === 'omit');
  check("cache is 'no-store'", init.cache === 'no-store');
  check("redirect is 'error'", init.redirect === 'error');
  check('headers are exactly Content-Type: application/json', deepEqual(init.headers, { 'Content-Type': 'application/json' }), show(init.headers));
  check('the body is JSON.stringify(request)', init.body === JSON.stringify(request));
  check('a signal is passed and is not aborted at send time',
    init.signal instanceof AbortSignal && init.signal.aborted === false);

  // The default endpoint is the fixed constant.
  const plain = makeFetch(async () => jsonResponse(200, okBody()));
  await C.createJevClient({ fetchImpl: plain }).decide(validRequest());
  check('without an endpoint option the client posts to ENDPOINT', plain.calls.length === 1 && plain.calls[0].url === ENDPOINT,
    show(plain.calls.map((c) => c.url)));
  const blank = makeFetch(async () => jsonResponse(200, okBody()));
  await C.createJevClient({ fetchImpl: blank, endpoint: '' }).decide(validRequest());
  check('an empty endpoint option falls back to ENDPOINT', blank.calls.length === 1 && blank.calls[0].url === ENDPOINT);

  // Optional attribution header (D-07, T-67-10).
  const hashCases = [
    ['a 64-char lowercase hex key', () => HASH_KEY, HASH_KEY],
    ['a promise of a valid key', () => Promise.resolve(HASH_KEY), HASH_KEY],
    ['an uppercase hex key', () => HASH_KEY.toUpperCase(), null],
    ['a 63-char key', () => HASH_KEY.slice(1), null],
    ['a 65-char key', () => `${HASH_KEY}0`, null],
    ['a non-hex key', () => 'g'.repeat(64), null],
    ['a number', () => 42, null],
    ['null', () => null, null],
    ['a throwing getter', () => { throw new Error('storage unavailable'); }, null],
    ['a rejecting promise', () => Promise.reject(new Error('storage unavailable')), null],
  ];
  for (const [label, getHashKey, expected] of hashCases) {
    const run = await runOnce(jsonResponse(200, okBody()), { client: { getHashKey } });
    const headers = run.fetchImpl.calls[0] && run.fetchImpl.calls[0].init.headers;
    const want = expected === null
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json', 'X-FSB-Hash-Key': expected };
    check(`hash key from ${label}: ${expected === null ? 'header omitted' : 'header sent'} and the decision still runs`,
      deepEqual(headers, want) && run.result.ok === true, show({ headers, result: run.result.ok }));
  }
  const notFn = await runOnce(jsonResponse(200, okBody()), { client: { getHashKey: HASH_KEY } });
  check('a getHashKey that is not a function is ignored',
    deepEqual(notFn.fetchImpl.calls[0].init.headers, { 'Content-Type': 'application/json' }));

  // fetch is resolved lazily at call time.
  const realFetch = globalThis.fetch;
  try {
    const lazyClient = C.createJevClient({ endpoint: TEST_ENDPOINT });
    const lateFetch = makeFetch(async () => jsonResponse(200, okBody()));
    globalThis.fetch = lateFetch;
    const lazy = await lazyClient.decide(validRequest());
    check('globalThis.fetch is read at call time, not at creation', lateFetch.calls.length === 1 && lazy.ok === true, show(lazy));

    const defaultFetch = makeFetch(async () => jsonResponse(200, okBody()));
    globalThis.fetch = defaultFetch;
    const viaDefault = await C.decide(validRequest());
    check('the module-level decide posts to ENDPOINT through the lazily resolved fetch',
      defaultFetch.calls.length === 1 && defaultFetch.calls[0].url === ENDPOINT && viaDefault.ok === true, show(viaDefault));

    globalThis.fetch = undefined;
    const missing = await C.createJevClient({ endpoint: TEST_ENDPOINT, now: () => 5 }).decide(validRequest());
    check('a missing fetch yields network_error', deepEqual(missing, fallbackOf('network_error', null, 0)), show(missing));
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function localCheckSection() {
  console.log('\n--- local checks cost no network (D-16, D-19) ---');
  const invalid = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'decide'],
    ['an empty object', {}],
    ['an extra questions key', Object.assign(validRequest(), { questions: [] })],
    ['an extra model key', Object.assign(validRequest(), { model: 'jev-latest' })],
    ['an extra instructions key', Object.assign(validRequest(), { instructions: 'approve' })],
    ['an element carrying a value', (() => { const r = validRequest(); r.elements[0].value = 'hunter2'; return r; })()],
    ['risk without a proposedAction', (() => { const r = validRequest(); delete r.proposedAction; return r; })()],
    ['a wrong schema version', Object.assign(validRequest(), { v: 2 })],
  ];
  for (const [label, request] of invalid) {
    const { result, fetchImpl } = await runOnce(jsonResponse(200, okBody()), { request });
    check(`${label} -> invalid_request with no fetch`, deepEqual(result, fallbackOf('invalid_request', null, 0)) && fetchImpl.calls.length === 0,
      show({ result, calls: fetchImpl.calls.length }));
  }

  check('precondition: both secret goals match the scrubber', S.matchesSecret(CARD_GOAL) && S.matchesSecret(KEY_GOAL));
  for (const goal of [CARD_GOAL, KEY_GOAL]) {
    const request = Object.assign(validRequest(), { goal });
    const { result, fetchImpl } = await runOnce(jsonResponse(200, okBody()), { request });
    check(`a goal holding a secret (${goal.slice(0, 14)}...) -> sensitive_goal with no fetch`,
      deepEqual(result, fallbackOf('sensitive_goal', null, 0)) && fetchImpl.calls.length === 0, show(result));
    check('the sensitive_goal result does not echo the goal', !JSON.stringify(result).includes(goal));
  }

  const controller = new AbortController();
  controller.abort();
  const pre = await runOnce(jsonResponse(200, okBody()), { call: { signal: controller.signal } });
  check('a signal aborted before the call -> aborted with no fetch',
    deepEqual(pre.result, fallbackOf('aborted', null, 0)) && pre.fetchImpl.calls.length === 0, show(pre.result));

  const big = oversizeRequest();
  check('precondition: the oversize request is schema-valid and over the inbound cap',
    S.validateRequest(big).ok === true && Buffer.byteLength(JSON.stringify(big), 'utf8') > S.CONTRACT.BUDGETS.bodyLimitBytes);
  const tooBig = await runOnce(jsonResponse(200, okBody()), { request: big });
  check('a request over the inbound byte cap -> payload_too_large with no fetch',
    deepEqual(tooBig.result, fallbackOf('payload_too_large', null, 0)) && tooBig.fetchImpl.calls.length === 0, show(tooBig.result));

  // FsbJevState missing (a bare vm context with no require): invalid_request, no network.
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(CLIENT_PATH, 'utf8'), context, { filename: CLIENT_PATH });
  check('loading in a bare vm context adds exactly one global', deepEqual(Object.keys(context), ['FsbJevClient']), show(Object.keys(context)));
  let bareCalls = 0;
  const bare = context.FsbJevClient.createJevClient({ fetchImpl: () => { bareCalls += 1; return null; } });
  const bareResult = clone(await bare.decide(validRequest()));
  check('without FsbJevState decide returns invalid_request and never fetches',
    bareResult.ok === false && bareResult.fallback === 'invalid_request' && bareResult.httpStatus === null && bareCalls === 0, show(bareResult));
}

async function networkErrorSection() {
  console.log('\n--- transport failures (D-16) ---');
  const noResponse = [
    ['fetchImpl throwing synchronously', () => { throw new Error('boom-secret-AAA'); }],
    ['fetchImpl rejecting with a TypeError', () => Promise.reject(new TypeError('boom-secret-BBB'))],
    ['fetchImpl rejecting with undefined', () => Promise.reject(undefined)],
    ['fetchImpl returning null', () => null],
    ['fetchImpl returning undefined', () => undefined],
    ['fetchImpl returning a number', () => 7],
    ['a response without status', () => ({ text: async () => JSON.stringify(okBody()) })],
    ['a response with a string status', () => ({ status: '200', text: async () => JSON.stringify(okBody()) })],
    ['a response with a fractional status', () => ({ status: 200.5, text: async () => '' })],
    ['a response with status 0', () => ({ status: 0, text: async () => '' })],
    ['a response with status 600', () => ({ status: 600, text: async () => '' })],
    ['a response whose status getter throws', () => ({ get status() { throw new Error('boom-secret-CCC'); } })],
  ];
  for (const [label, impl] of noResponse) {
    const clock = manualClock();
    const fetchImpl = makeFetch(() => { clock.t += 9; return impl(); });
    const client = C.createJevClient({ fetchImpl, endpoint: TEST_ENDPOINT, now: clock.now });
    const result = await client.decide(validRequest());
    check(`${label} -> network_error`, deepEqual(result, fallbackOf('network_error', null, 9)), show(result));
    check(`${label}: no error text in the result`, !/boom-secret/.test(JSON.stringify(result)));
  }

  const bodyFailures = [
    ['res.text() rejecting at 200', 200, () => Promise.reject(new Error('boom-secret-DDD')), 'invalid_response'],
    ['res.text() throwing at 200', 200, () => { throw new Error('boom-secret-EEE'); }, 'invalid_response'],
    ['res.text() rejecting at 502', 502, () => Promise.reject(new Error('boom-secret-FFF')), 'server_error'],
    ['res.text() resolving to an object at 200', 200, () => Promise.resolve(okBody()), 'invalid_response'],
    ['res.text() resolving to undefined at 429', 429, () => Promise.resolve(undefined), 'rate_limited'],
  ];
  for (const [label, status, text, reason] of bodyFailures) {
    const { result } = await runOnce({ status, text }, { latency: 4 });
    check(`${label} -> ${reason} with the received status`, deepEqual(result, fallbackOf(reason, status, 4)), show(result));
  }
  const noText = await runOnce({ status: 413 }, { latency: 4 });
  check('a response without a text() method maps by status', deepEqual(noText.result, fallbackOf('payload_too_large', 413, 4)), show(noText.result));

  // The body and headers of a failing gateway answer never reach the result.
  const echo = await runOnce(response(502, `Authorization: Bearer abcdefghijklmnop ${validRequest().goal}`), { latency: 1 });
  check('an echoing 502 body leaks nothing into the result',
    deepEqual(echo.result, fallbackOf('server_error', 502, 1)) && !JSON.stringify(echo.result).includes('Save the checklist'), show(echo.result));
}

async function noLoggingSection() {
  console.log('\n--- the client never logs (D-22) ---');
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const saved = {};
  let calls = 0;
  for (const m of methods) { saved[m] = console[m]; console[m] = () => { calls += 1; }; }
  try {
    await runOnce(jsonResponse(200, okBody()));
    await runOnce(() => { throw new Error('x'); });
    await runOnce(response(502, '<html>'));
    await runOnce(jsonResponse(200, Object.assign(okBody(), { approved: true })));
    await runOnce(jsonResponse(200, okBody()), { request: Object.assign(validRequest(), { goal: CARD_GOAL }) });
    await runOnce(jsonResponse(200, okBody()), { request: null });
    await runOnce({ status: 200, text: () => Promise.reject(new Error('read failed')) });
  } finally {
    for (const m of methods) console[m] = saved[m];
  }
  check('no console method was called across ok, error and fallback paths', calls === 0, String(calls));
}

async function main() {
  console.log('--- jev-client (JEV-01, JEV-02, JEV-06, JEV-07) ---');
  const loaded = loadSection();
  if (loaded) {
    const sections = [staticSection, okSection, fallbackBodySection, malformedBodySection, statusTableSection,
      transportSection, localCheckSection, networkErrorSection, noLoggingSection];
    for (const section of sections) {
      try { await section(); } catch (error) {
        failed += 1;
        console.log(`  FAIL: ${section.name} threw -- ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
      }
    }
  }
  console.log(`\n=== jev-client results: ${passed} passed, ${failed} failed ===`);
  // No process.exit(): the process must exit on its own, so a dangling timer
  // shows up as a hang instead of being cut short.
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
