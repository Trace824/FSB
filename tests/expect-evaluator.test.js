'use strict';

/**
 * Phase 69 Plan 03 -- same-call `expect` evaluator (MCP-02, SC2).
 *
 * Exercises the expect contract in extension/utils/action-verification.js in
 * plain Node: the frozen constants (D-12, D-13, D-19, D-20), spec
 * normalization, timeout clamping, status aggregation, observed-string caps,
 * the sensitive-field predicate, the uncertain-result builder, the
 * self-contained page probe (driven against stub window/document objects) and
 * the bounded evaluation loop (driven with injected deps and a fake clock).
 *
 * Browser globals are stubbed before the require, in the change-report-builder
 * style, although the module touches no DOM global at load time.
 *
 * Run: node tests/expect-evaluator.test.js
 */

const assert = require('node:assert/strict');

// --- Browser global stubs (same shape as tests/change-report-builder.test.js) ---
global.window = global.window || { location: { href: 'https://example.com/' } };
global.document = global.document || {
  title: 'Example',
  body: { innerText: '' },
  activeElement: null,
  documentElement: { tagName: 'HTML' },
  querySelectorAll: () => [],
  querySelector: () => null,
};
global.MutationObserver = global.MutationObserver || function StubObserver() {
  this.observe = () => {};
  this.disconnect = () => {};
};

const MODULE_PATH = require.resolve('../extension/utils/action-verification.js');
delete require.cache[MODULE_PATH];
const av = require(MODULE_PATH);

const STUB_WINDOW = global.window;
const STUB_DOCUMENT = global.document;

let passed = 0;
let failed = 0;
const pending = [];

function check(label, fn) {
  try { fn(); passed++; console.log('  PASS:', label); }
  catch (e) { failed++; console.error('  FAIL:', label, '\n    ', e && e.message); }
}

function checkAsync(label, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  PASS:', label); }
    catch (e) { failed++; console.error('  FAIL:', label, '\n    ', e && e.message); }
  });
}

// =============================================================================
// Task 1 -- constants and pure helpers
// =============================================================================

console.log('\n--- expect contract constants ---');

const D12_ORDER = [
  'execute_js', 'click', 'right_click', 'double_click', 'click_at', 'double_click_at', 'click_and_hold',
  'type_text', 'insert_text', 'press_enter', 'press_key', 'clear_input',
  'select_option', 'check_box', 'set_attribute',
  'drag_drop', 'drag', 'drag_variable_speed', 'drop_file', 'upload_file',
  'select_text_range', 'scroll_to_top', 'scroll_to_bottom', 'scroll_to_element',
  'navigate', 'go_back', 'go_forward', 'refresh', 'back'
];

check('EXPECT_TOOL_NAMES has the 29 D-12 tools in the exact order', () => {
  assert.equal(av.EXPECT_TOOL_NAMES.length, 29);
  assert.deepEqual(Array.from(av.EXPECT_TOOL_NAMES), D12_ORDER);
});

check('EXPECT_NAV_TOOL_NAMES lists the five navigation tools', () => {
  assert.deepEqual(Array.from(av.EXPECT_NAV_TOOL_NAMES), ['navigate', 'go_back', 'go_forward', 'refresh', 'back']);
  for (const name of av.EXPECT_NAV_TOOL_NAMES) assert.ok(av.EXPECT_TOOL_NAMES.includes(name), name);
});

check('spec, predicate, state, result and check key lists match the shared contract', () => {
  assert.deepEqual(Array.from(av.EXPECT_SPEC_KEYS),
    ['url_includes', 'title_includes', 'text_visible', 'text_gone', 'selector', 'state', 'value', 'dialog_open', 'timeout_ms']);
  assert.deepEqual(Array.from(av.EXPECT_PREDICATE_KEYS),
    ['url_includes', 'title_includes', 'text_visible', 'text_gone', 'selector', 'dialog_open']);
  assert.deepEqual(Array.from(av.EXPECT_STATES), ['visible', 'gone', 'checked', 'unchecked']);
  assert.deepEqual(Array.from(av.EXPECT_RESULT_KEYS), ['status', 'checks', 'waited_ms', 'timeout_ms', 'reason']);
  assert.deepEqual(Array.from(av.EXPECT_CHECK_KEYS), ['kind', 'expected', 'observed', 'status']);
  assert.deepEqual(Array.from(av.EXPECT_CHECK_KINDS),
    ['url_includes', 'title_includes', 'text_visible', 'text_gone', 'state', 'value', 'dialog_open']);
  assert.deepEqual(Array.from(av.EXPECT_STATUSES), ['verified', 'unmet', 'uncertain']);
  assert.deepEqual(Array.from(av.EXPECT_CHECK_STATUSES), ['met', 'unmet', 'uncertain']);
});

check('timing and size constants hold the D-20 values', () => {
  assert.equal(av.EXPECT_DEFAULT_TIMEOUT_MS, 2000);
  assert.equal(av.EXPECT_MAX_TIMEOUT_MS, 5000);
  assert.equal(av.EXPECT_POLL_INTERVAL_MS, 200);
  assert.equal(av.EXPECT_OBSERVED_MAX, 120);
  assert.equal(av.EXPECT_STRING_MAX, 2000);
  assert.equal(av.EXPECT_TEXT_SCAN_MAX_CHARS, 200000);
  assert.equal(av.EXPECT_SHADOW_HOST_BUDGET, 2000);
  assert.equal(av.EXPECT_REDACTED, '[redacted]');
  assert.equal(typeof av.EXPECT_SENSITIVE_NAME_SOURCE, 'string');
  assert.doesNotThrow(() => new RegExp(av.EXPECT_SENSITIVE_NAME_SOURCE, 'i'));
});

check('EXPECT_UNCERTAIN_REASONS lists every reason, including extension_unsupported', () => {
  assert.deepEqual(Array.from(av.EXPECT_UNCERTAIN_REASONS), [
    'extension_unsupported', 'invalid_expect', 'evaluator_unavailable', 'evaluator_failed', 'no_tab',
    'tab_closed', 'restricted_page', 'no_commit', 'still_loading', 'page_unresponsive', 'probe_failed',
    'probe_timeout', 'stale_document', 'ref_unavailable', 'invalid_selector', 'text_budget_exhausted',
    'no_toggle_signal', 'value_unreadable'
  ]);
  assert.ok(av.EXPECT_UNCERTAIN_REASONS.includes('extension_unsupported'));
});

check('every array constant is frozen', () => {
  for (const name of [
    'EXPECT_TOOL_NAMES', 'EXPECT_NAV_TOOL_NAMES', 'EXPECT_SPEC_KEYS', 'EXPECT_PREDICATE_KEYS', 'EXPECT_STATES',
    'EXPECT_RESULT_KEYS', 'EXPECT_CHECK_KEYS', 'EXPECT_CHECK_KINDS', 'EXPECT_STATUSES', 'EXPECT_CHECK_STATUSES',
    'EXPECT_UNCERTAIN_REASONS'
  ]) {
    assert.ok(Array.isArray(av[name]), `${name} is an array`);
    assert.ok(Object.isFrozen(av[name]), `${name} is frozen`);
  }
});

console.log('\n--- clampExpectTimeoutMs ---');

check('clampExpectTimeoutMs follows the D-20 table', () => {
  const rows = [
    [undefined, 2000], [null, 2000], ['abc', 2000], [NaN, 2000], [Infinity, 2000],
    [-5, 0], [0, 0], [1234.9, 1234], ['3000', 3000], [99999, 5000], [5000, 5000]
  ];
  for (const [input, want] of rows) {
    assert.equal(av.clampExpectTimeoutMs(input), want, `clamp(${String(input)})`);
  }
});

console.log('\n--- normalizeExpectSpec ---');

function invalid(raw, label) {
  const r = av.normalizeExpectSpec(raw);
  assert.equal(r.ok, false, `${label} should be invalid`);
  assert.equal(r.reason, 'invalid_expect', `${label} reason`);
  assert.equal(typeof r.detail, 'string', `${label} detail`);
}

check('rejects empty, predicate-less, orphan state/value, bad enum, unknown key and empty strings', () => {
  invalid({}, '{}');
  invalid({ timeout_ms: 100 }, 'timeout only');
  invalid({ state: 'checked' }, 'state without selector');
  invalid({ value: 'x' }, 'value without selector');
  invalid({ selector: '#a', state: 'bogus' }, 'bad state');
  invalid({ bogus: 1 }, 'unknown key');
  invalid({ text_visible: 'a', bogus: 1 }, 'unknown key beside a predicate');
  invalid({ text_visible: '' }, 'empty text_visible');
  invalid({ url_includes: '' }, 'empty url_includes');
  invalid({ selector: '' }, 'empty selector');
  invalid({ text_visible: 5 }, 'non-string text_visible');
  invalid({ dialog_open: 'yes' }, 'non-boolean dialog_open');
  invalid({ text_visible: 'a', timeout_ms: 'abc' }, 'non-numeric timeout_ms');
  invalid({ text_visible: 'a', timeout_ms: 1.5 }, 'fractional timeout_ms');
  invalid({ text_visible: 'a', timeout_ms: '' }, 'empty-string timeout_ms');
});

check('rejects a 2,001-character string and non-object specs', () => {
  invalid({ text_visible: 'x'.repeat(2001) }, '2001-char text_visible');
  invalid({ selector: '#a', value: 'x'.repeat(2001) }, '2001-char value');
  invalid([], 'array');
  invalid(null, 'null');
  invalid('str', 'string');
  invalid(undefined, 'undefined');
  invalid(Object.create({ text_visible: 'x' }), 'non-plain object');
  const ok = av.normalizeExpectSpec({ text_visible: 'x'.repeat(2000) });
  assert.equal(ok.ok, true, 'a 2000-char string is still accepted');
});

check("value: '' is a valid check (D-13); empty strings stay invalid elsewhere", () => {
  const r = av.normalizeExpectSpec({ selector: '#q', value: '' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec.checks, [{ kind: 'value', expected: '', selector: '#q' }]);
  invalid({ selector: '', value: 'x' }, 'empty selector with value');
  invalid({ selector: '#q', value: '', text_visible: '' }, 'empty text_visible beside value ""');
});

check('a bare selector means state visible; value alone yields only a value check', () => {
  const a = av.normalizeExpectSpec({ selector: '#a' });
  assert.equal(a.ok, true);
  assert.deepEqual(a.spec.checks, [{ kind: 'state', expected: 'visible', selector: '#a' }]);
  const b = av.normalizeExpectSpec({ selector: '#a', value: 'x' });
  assert.deepEqual(b.spec.checks, [{ kind: 'value', expected: 'x', selector: '#a' }]);
  const c = av.normalizeExpectSpec({ selector: '#a', state: 'checked', value: 'x' });
  assert.deepEqual(c.spec.checks.map((k) => k.kind), ['state', 'value']);
  assert.equal(c.spec.checks[0].expected, 'checked');
});

check('every predicate yields kinds in the fixed order; timeoutMs is clamped', () => {
  const r = av.normalizeExpectSpec({
    dialog_open: false, value: 'v', state: 'gone', selector: '#s', text_gone: 'Loading',
    text_visible: 'Saved', title_includes: 'Inbox', url_includes: '/done', timeout_ms: 99999
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec.checks.map((k) => k.kind),
    ['url_includes', 'title_includes', 'text_visible', 'text_gone', 'state', 'value', 'dialog_open']);
  assert.equal(r.spec.timeoutMs, 5000);
  assert.equal(r.spec.checks[6].expected, false);
  assert.equal(av.normalizeExpectSpec({ text_visible: 'a' }).spec.timeoutMs, 2000);
  assert.equal(av.normalizeExpectSpec({ text_visible: 'a', timeout_ms: '300' }).spec.timeoutMs, 300);
  assert.equal(av.normalizeExpectSpec({ text_visible: 'a', timeout_ms: -50 }).spec.timeoutMs, 0);
});

check('a value check on a sensitive-looking selector carries sensitiveHint', () => {
  const pw = av.normalizeExpectSpec({ selector: 'input[type="password"]', value: 'x' });
  assert.equal(pw.spec.checks[0].sensitiveHint, true);
  const otp = av.normalizeExpectSpec({ selector: '#otp-code', value: '1' });
  assert.equal(otp.spec.checks[0].sensitiveHint, true);
  const plain = av.normalizeExpectSpec({ selector: '#footprint', value: '1' });
  assert.equal('sensitiveHint' in plain.spec.checks[0], false);
});

console.log('\n--- aggregateExpectStatus / capObserved ---');

check('aggregateExpectStatus: verified, unmet, uncertain', () => {
  const s = (...xs) => xs.map((status) => ({ status }));
  assert.equal(av.aggregateExpectStatus(s('met', 'met')), 'verified');
  assert.equal(av.aggregateExpectStatus(s('met', 'unmet', 'uncertain')), 'unmet');
  assert.equal(av.aggregateExpectStatus(s('met', 'uncertain')), 'uncertain');
  assert.equal(av.aggregateExpectStatus([]), 'uncertain');
  assert.equal(av.aggregateExpectStatus(null), 'uncertain');
});

check('capObserved caps strings at 120 characters', () => {
  const long = 'a'.repeat(121);
  const capped = av.capObserved(long);
  assert.equal(capped.length, 120);
  assert.ok(capped.endsWith('...'));
  assert.equal(capped.slice(0, 117), 'a'.repeat(117));
  assert.equal(av.capObserved('a'.repeat(120)), 'a'.repeat(120));
  assert.equal(av.capObserved('short'), 'short');
  assert.equal(av.capObserved(true), true);
  assert.equal(av.capObserved(null), null);
});

console.log('\n--- isRedactedField ---');

const f = (o) => av.isRedactedField(Object.assign({ tag: 'input', type: 'text' }, o));

check('password, hidden, credential autocomplete and sensitive names are redacted', () => {
  assert.equal(f({ type: 'password' }), true, 'password');
  assert.equal(f({ type: 'hidden' }), true, 'hidden');
  assert.equal(f({ autocomplete: 'cc-number' }), true, 'cc-number');
  assert.equal(f({ autocomplete: 'current-password' }), true, 'current-password');
  assert.equal(f({ autocomplete: 'new-password' }), true, 'new-password');
  assert.equal(f({ autocomplete: 'one-time-code' }), true, 'one-time-code');
  assert.equal(f({ autocomplete: 'shipping cc-csc' }), true, 'shipping cc-csc');
  assert.equal(f({ name: 'cvv' }), true, 'cvv');
  assert.equal(f({ id: 'otp-code' }), true, 'otp-code');
  assert.equal(f({ id: 'otpCode' }), true, 'otpCode');
  assert.equal(f({ id: 'OTPCode' }), true, 'OTPCode');
  assert.equal(f({ name: 'userPwd' }), true, 'userPwd');
  assert.equal(f({ name: 'card_number' }), true, 'card_number');
  assert.equal(f({ id: 'totp' }), true, 'totp');
  assert.equal(f({ id: 'TOTPCode' }), true, 'TOTPCode');
  assert.equal(f({ name: 'passwd' }), true, 'passwd');
  assert.equal(f({ name: 'Passwd' }), true, 'Passwd');
  assert.equal(f({ name: 'newPassword' }), true, 'newPassword');
  assert.equal(f({ name: 'security_code' }), true, 'security_code');
});

check('ordinary fields stay non-sensitive (boundary-aware short terms)', () => {
  assert.equal(f({ name: 'email' }), false, 'email');
  assert.equal(f({ id: 'footprint' }), false, 'footprint');
  assert.equal(f({ id: 'hotpot' }), false, 'hotpot');
  assert.equal(f({ name: 'notpad' }), false, 'notpad');
  assert.equal(f({ name: 'passport' }), false, 'passport');
  assert.equal(f({ name: 'account_number' }), false, 'account_number');
  assert.equal(f({ autocomplete: 'off' }), false, 'autocomplete off');
  assert.equal(av.isRedactedField({ tag: 'textarea', type: 'textarea', name: 'notes' }), false, 'textarea notes');
  assert.equal(av.isRedactedField({ tag: 'div' }), false, 'contenteditable div');
  assert.equal(av.isRedactedField(null), false, 'null');
});

check('run-together lowercase ids are a documented miss of the name rule only', () => {
  assert.equal(f({ id: 'otpcode' }), false, 'otpcode (name rule only)');
  assert.equal(f({ id: 'otpcode', autocomplete: 'one-time-code' }), true, 'autocomplete still applies');
});

console.log('\n--- buildUncertainExpectResult ---');

check('buildUncertainExpectResult has exactly the result and check keys, observed null', () => {
  const spec = av.normalizeExpectSpec({
    url_includes: '/a', title_includes: 'T', text_visible: 'x', text_gone: 'y',
    selector: '#s', value: 'v', dialog_open: true, timeout_ms: 700
  }).spec;
  const r = av.buildUncertainExpectResult(spec, 'extension_unsupported');
  assert.deepEqual(Object.keys(r), ['status', 'checks', 'waited_ms', 'timeout_ms', 'reason']);
  assert.equal(r.status, 'uncertain');
  assert.equal(r.reason, 'extension_unsupported');
  assert.equal(r.waited_ms, 0);
  assert.equal(r.timeout_ms, 700);
  assert.equal(r.checks.length, 6);
  for (const c of r.checks) {
    assert.deepEqual(Object.keys(c), ['kind', 'expected', 'observed', 'status']);
    assert.equal(c.observed, null);
    assert.equal(c.status, 'uncertain');
  }
  const value = r.checks.find((c) => c.kind === 'value');
  assert.equal(value.expected, av.EXPECT_REDACTED, 'an unobserved value check never echoes the expected value');
});

check('buildUncertainExpectResult(null, reason) uses the default timeout and no checks', () => {
  const r = av.buildUncertainExpectResult(null, 'invalid_expect');
  assert.deepEqual(r, { status: 'uncertain', checks: [], waited_ms: 0, timeout_ms: 2000, reason: 'invalid_expect' });
});

console.log('\n--- existing change-report exports ---');

check('the module still exports the change-report builder unchanged', () => {
  assert.equal(typeof av.buildChangeReport, 'function');
  assert.equal(typeof av.applyChangeReportSizeCap, 'function');
  const r = av.buildChangeReport({ url: 'u', inputValues: { email: '' } }, { url: 'u', inputValues: { email: 'a@b.c' } }, [], {});
  assert.deepEqual(r.inputs_changed, { email: { before: '', after: 'a@b.c' } });
});

// =============================================================================
// Runner
// =============================================================================

(async () => {
  for (const run of pending) await run();
  global.window = STUB_WINDOW;
  global.document = STUB_DOCUMENT;
  console.log(`\n[expect-evaluator] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
