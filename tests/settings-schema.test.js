'use strict';

/**
 * Phase 66.1 settings schema (globalThis.FsbSettingsSchema in
 * extension/config/config.js): the single source of truth for MCP settings
 * reads and writes (D-08).
 *
 * Covers the 35-key contract (D-09), secret masking (D-10), origin-only
 * endpoint reads (D-11), effective defaults and read purity (D-12), strict
 * value-free parsing (D-04, D-14), the test-only fixture factory (D-17) and
 * the config.js scope safety the service worker depends on.
 *
 * Node 20-safe: fs, path, vm and assert only; no ports, no global WebSocket.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CONFIG_PATH = path.join(__dirname, '..', 'extension', 'config', 'config.js');
const CONFIG_SOURCE = fs.readFileSync(CONFIG_PATH, 'utf8');
const configModule = require(CONFIG_PATH);
const { Config, config } = configModule;
const schema = configModule.FsbSettingsSchema;

let passed = 0;
let failed = 0;

function check(cond, msg) {
  if (cond) {
    passed++;
    console.log('  PASS:', msg);
  } else {
    failed++;
    console.error('  FAIL:', msg);
  }
}

function isDeepEqual(actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    return true;
  } catch (_e) {
    return false;
  }
}

function checkDeep(actual, expected, msg) {
  const ok = isDeepEqual(actual, expected);
  check(ok, ok ? msg : `${msg} (got ${JSON.stringify(actual)})`);
}

function throwsTypeError(fn) {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof TypeError;
  }
}

// ---------------------------------------------------------------------------
// The SETTINGS CONTRACT shared by plans 66.1-01..08 (D-09 order: the
// saveSettings object order, then the four other control-panel writers).
// ---------------------------------------------------------------------------
const PROVIDER_IDS = ['xai', 'gemini', 'openai', 'anthropic', 'openrouter', 'lmstudio', 'custom'];
const EXPECTED_ENTRIES = [
  { key: 'providerKind', type: 'enum', cls: 'writable', default: 'api', values: ['api', 'agent'], group: 'provider' },
  { key: 'agentProviderId', type: 'string', cls: 'writable', default: '', maxLength: 64, group: 'provider' },
  { key: 'modelProvider', type: 'enum', cls: 'writable', default: 'xai', values: PROVIDER_IDS, group: 'provider' },
  { key: 'modelName', type: 'string', cls: 'writable', default: 'grok-4-1-fast', maxLength: 200, group: 'provider' },
  { key: 'apiKey', type: 'string', cls: 'secret', default: '' },
  { key: 'geminiApiKey', type: 'string', cls: 'secret', default: '' },
  { key: 'openaiApiKey', type: 'string', cls: 'secret', default: '' },
  { key: 'anthropicApiKey', type: 'string', cls: 'secret', default: '' },
  { key: 'customApiKey', type: 'string', cls: 'secret', default: '' },
  { key: 'customEndpoint', type: 'string', cls: 'endpoint', default: '' },
  { key: 'openrouterApiKey', type: 'string', cls: 'secret', default: '' },
  { key: 'lmstudioBaseUrl', type: 'string', cls: 'endpoint', default: 'http://localhost:1234' },
  { key: 'maxIterations', type: 'integer', cls: 'writable', default: 100, min: 50, max: 500 },
  { key: 'debugMode', type: 'boolean', cls: 'writable', default: false },
  { key: 'domOptimization', type: 'boolean', cls: 'writable', default: true },
  { key: 'maxDOMElements', type: 'integer', cls: 'writable', default: 2000, min: 500, max: 5000 },
  { key: 'elementCacheSize', type: 'integer', cls: 'writable', default: 200, min: 10, max: 1000 },
  { key: 'prioritizeViewport', type: 'boolean', cls: 'writable', default: true },
  { key: 'animatedActionHighlights', type: 'boolean', cls: 'writable', default: true },
  { key: 'showSidepanelProgress', type: 'boolean', cls: 'writable', default: true },
  { key: 'enableLogin', type: 'boolean', cls: 'writable', default: false },
  { key: 'captchaSolverEnabled', type: 'boolean', cls: 'writable', default: false },
  { key: 'captchaApiKey', type: 'string', cls: 'secret', default: '' },
  { key: 'sttProvider', type: 'enum', cls: 'writable', default: 'browser', values: ['browser', 'whisper'] },
  { key: 'voiceInputEnabled', type: 'boolean', cls: 'writable', default: true },
  { key: 'autoRefineSiteMaps', type: 'boolean', cls: 'writable', default: true },
  { key: 'fsbAgentCap', type: 'integer', cls: 'writable', default: { from: 'agentCapRecommendation' }, min: 1, max: 64 },
  { key: 'fsbTriggerCap', type: 'integer', cls: 'writable', default: 8, min: 1, max: 64 },
  { key: 'fsbChangeReportsEnabled', type: 'boolean', cls: 'writable', default: true },
  { key: 'fsbMcpSessionRecordingEnabled', type: 'boolean', cls: 'writable', default: true },
  { key: 'fsbMcpSessionRetentionDays', type: 'integer', cls: 'writable', default: 30, min: 1, max: 365 },
  { key: 'autoAnalyzeMemories', type: 'boolean', cls: 'writable', default: true },
  { key: 'fsbTelemetryOptOut', type: 'boolean', cls: 'writable', default: false },
  { key: 'serverUrl', type: 'string', cls: 'endpoint', default: 'https://full-selfbrowsing.com' },
  { key: 'serverHashKey', type: 'string', cls: 'secret', default: '' },
];
const EXPECTED_KEYS = EXPECTED_ENTRIES.map((entry) => entry.key);
const SECRET_KEYS = ['apiKey', 'geminiApiKey', 'openaiApiKey', 'anthropicApiKey', 'openrouterApiKey', 'customApiKey', 'captchaApiKey', 'serverHashKey'];
const ENDPOINT_KEYS = ['customEndpoint', 'lmstudioBaseUrl', 'serverUrl'];
const EXPECTED_READ_ONLY = EXPECTED_KEYS.filter((key) => SECRET_KEYS.includes(key) || ENDPOINT_KEYS.includes(key));
const PROVIDER_GROUP_KEYS = ['providerKind', 'agentProviderId', 'modelProvider', 'modelName'];
const ALLOWED_FIELDS = ['key', 'type', 'cls', 'default', 'min', 'max', 'values', 'maxLength', 'group'];

// Snapshot of Config.defaults before Phase 66.1 (D-08 keeps all three default
// copies unchanged; the effective-default divergences are pinned in 66.1-02).
const CONFIG_DEFAULTS_SNAPSHOT = {
  providerKind: 'api',
  agentProviderId: '',
  modelProvider: 'xai',
  modelName: 'grok-4-1-fast',
  apiKey: '',
  geminiApiKey: '',
  openaiApiKey: '',
  anthropicApiKey: '',
  openrouterApiKey: '',
  customApiKey: '',
  customEndpoint: '',
  lmstudioBaseUrl: 'http://localhost:1234',
  speedMode: 'normal',
  maxIterations: 100,
  debugMode: false,
  domOptimization: true,
  maxDOMElements: 2000,
  elementCacheSize: 200,
  prioritizeViewport: true,
  animatedActionHighlights: true,
  showSidepanelProgress: false,
  enableLogin: false,
  enableSavedPayments: false,
  captchaSolverEnabled: false,
  captchaApiKey: '',
  serverUrl: 'https://fsb-server.fly.dev',
  serverHashKey: '',
  serverSyncEnabled: false,
};

console.log('\n--- exports ---');
check(typeof Config === 'function', 'config.js still exports the Config class');
check(config instanceof Config, 'config.js still exports the config singleton');
check(schema !== null && typeof schema === 'object', 'config.js exports FsbSettingsSchema on module.exports');
check(Boolean(schema) && globalThis.FsbSettingsSchema === schema, 'globalThis.FsbSettingsSchema is the exported schema');
checkDeep(new Config().defaults, CONFIG_DEFAULTS_SNAPSHOT, 'new Config().defaults is unchanged');
check(Boolean(schema) && Object.isFrozen(schema), 'the production schema object is frozen');

if (!schema) {
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(1);
}

console.log('\n--- statics ---');
checkDeep({ ...schema.CODES }, {
  REQUEST_INVALID: 'SETTING_REQUEST_INVALID',
  UNKNOWN_KEY: 'SETTING_UNKNOWN_KEY',
  PROTECTED_KEY: 'SETTING_PROTECTED_KEY',
  VALUE_INVALID: 'SETTING_VALUE_INVALID',
  PROVIDER_NOT_READY: 'SETTING_PROVIDER_NOT_READY',
  DELEGATED_WRITE_REFUSED: 'SETTING_DELEGATED_WRITE_REFUSED',
  UNSUPPORTED: 'SETTING_UNSUPPORTED',
  STORAGE_FAILED: 'SETTING_STORAGE_FAILED',
}, 'CODES lists the eight SETTING_ codes');
check(Object.isFrozen(schema.CODES), 'CODES is frozen');
check(schema.KEY_PATTERN instanceof RegExp && schema.KEY_PATTERN.source === '^[A-Za-z][A-Za-z0-9_]{0,63}$'
  && schema.KEY_PATTERN.flags === '', 'KEY_PATTERN is /^[A-Za-z][A-Za-z0-9_]{0,63}$/');
check(schema.KEY_PATTERN.test('apiKey') && !schema.KEY_PATTERN.test('1abc'), 'KEY_PATTERN still matches after export');
check(schema.VALUE_MAX_LENGTH === 2048, 'VALUE_MAX_LENGTH is 2048');
check(schema.MODEL_LIST_CAP === 25, 'MODEL_LIST_CAP is 25');
checkDeep([...schema.PROVIDERS], PROVIDER_IDS, 'PROVIDERS lists the seven provider ids in order');
check(Object.isFrozen(schema.PROVIDERS), 'PROVIDERS is frozen');
for (const name of ['create', 'originOnly', 'safeKeyLabel']) {
  check(typeof schema[name] === 'function', `static ${name} is a function`);
}

console.log('\n--- the 35-key contract (D-09) ---');
checkDeep(schema.keys(), EXPECTED_KEYS, 'keys() lists the 35 contract keys in order');
check(schema.keys().length === 35, 'there are exactly 35 keys');
checkDeep(schema.readOnlyKeys(), EXPECTED_READ_ONLY, 'readOnlyKeys() lists the 8 secrets and 3 endpoints in entry order');
check(schema.readOnlyKeys().length === 11, 'there are exactly 11 read-only keys');
check(schema.keys().filter((key) => schema.isWritable(key)).length === 24, '24 keys are writable');
check(schema.entries.length === 35, 'entries holds 35 entries');
EXPECTED_ENTRIES.forEach((expected, index) => {
  const entry = schema.entries[index];
  checkDeep({ ...entry }, expected, `entry ${index + 1} ${expected.key} matches the contract`);
});
check(schema.entries.filter((entry) => entry.cls === 'secret').map((entry) => entry.key).sort().join(',')
  === [...SECRET_KEYS].sort().join(','), 'the secret class holds exactly the eight D-10 keys');
check(schema.entries.filter((entry) => entry.cls === 'endpoint').map((entry) => entry.key).join(',')
  === ENDPOINT_KEYS.join(','), 'the endpoint class holds exactly the three D-11 keys');

console.log('\n--- entry shape ---');
for (const entry of schema.entries) {
  const fields = Object.keys(entry);
  const label = entry.key;
  check(fields.every((field) => ALLOWED_FIELDS.includes(field)), `${label} uses allowed fields only`);
  check(['boolean', 'integer', 'enum', 'string'].includes(entry.type), `${label} has a known type`);
  check(['writable', 'secret', 'endpoint'].includes(entry.cls), `${label} has a known class`);
  check(schema.KEY_PATTERN.test(entry.key), `${label} matches KEY_PATTERN`);
  if (entry.cls !== 'writable') check(entry.type === 'string', `${label} (${entry.cls}) is a string`);
  if (entry.type === 'integer') {
    check(Number.isInteger(entry.min) && Number.isInteger(entry.max) && entry.min <= entry.max, `${label} has integer bounds`);
    if (typeof entry.default === 'number') {
      check(Number.isInteger(entry.default) && entry.default >= entry.min && entry.default <= entry.max, `${label} default is inside its bounds`);
    } else {
      checkDeep({ ...entry.default }, { from: 'agentCapRecommendation' }, `${label} computed default names the agent-cap recommendation`);
      check(entry.key === 'fsbAgentCap', `${label} is the only computed default`);
    }
  } else {
    check(!('min' in entry) && !('max' in entry), `${label} has no min/max`);
  }
  if (entry.type === 'enum') {
    check(Array.isArray(entry.values) && entry.values.length > 0 && entry.values.includes(entry.default), `${label} enum default is in its values`);
  } else {
    check(!('values' in entry), `${label} has no values`);
  }
  if (entry.type === 'boolean') check(typeof entry.default === 'boolean', `${label} boolean default is boolean`);
  if (entry.type === 'string') check(typeof entry.default === 'string', `${label} string default is a string`);
  if ('maxLength' in entry) check(entry.type === 'string' && Number.isInteger(entry.maxLength) && entry.maxLength > 0, `${label} maxLength is a positive integer on a string`);
  if ('group' in entry) check(entry.group === 'provider' && PROVIDER_GROUP_KEYS.includes(entry.key), `${label} group is provider on a provider key`);
}
check(schema.entries.filter((entry) => entry.group === 'provider').map((entry) => entry.key).join(',')
  === PROVIDER_GROUP_KEYS.join(','), 'group provider is set on exactly the four provider keys');

console.log('\n--- deep freeze ---');
check(Object.isFrozen(schema.entries), 'entries is frozen');
check(schema.entries.every((entry) => Object.isFrozen(entry)), 'every entry is frozen');
check(schema.entries.filter((entry) => Array.isArray(entry.values)).every((entry) => Object.isFrozen(entry.values)), 'every values array is frozen');
check(Object.isFrozen(schema.get('fsbAgentCap').default), 'the computed default object is frozen');
check(throwsTypeError(() => { schema.entries.push({ key: 'x' }); }), 'pushing into the production entries throws in strict mode');
check(throwsTypeError(() => { schema.entries[0].key = 'hijacked'; }), 'renaming a production entry throws in strict mode');
check(throwsTypeError(() => { schema.get('sttProvider').values.push('other'); }), 'extending an enum throws in strict mode');
check(throwsTypeError(() => { schema.CODES.UNKNOWN_KEY = 'x'; }), 'CODES cannot be rewritten');
check(schema.keys().length === 35 && schema.entries[0].key === 'providerKind', 'the production schema is intact after tamper attempts');
const keysCopy = schema.keys();
keysCopy.push('extra');
check(schema.keys().length === 35, 'keys() returns a fresh array each call');

console.log('\n--- get / isWritable / safeKeyLabel ---');
check(schema.get('apiKey') === schema.entries[4], 'get(apiKey) returns its entry');
for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'unknownKey', '', 'a b']) {
  check(schema.get(name) === null, `get(${JSON.stringify(name)}) is null`);
}
for (const value of [undefined, null, 1, true, {}, ['apiKey']]) {
  check(schema.get(value) === null, `get(${JSON.stringify(value)}) is null for a non-string`);
}
check(schema.isWritable('maxIterations') === true, 'maxIterations is writable');
check(schema.isWritable('modelProvider') === true, 'modelProvider is writable (group rules apply later)');
check(schema.isWritable('apiKey') === false, 'apiKey is not writable');
check(schema.isWritable('serverUrl') === false, 'serverUrl is not writable');
check(schema.isWritable('constructor') === false, 'constructor is not writable');
check(schema.isWritable(42) === false, 'a non-string key is not writable');
check(schema.safeKeyLabel('apiKey') === 'apiKey', 'safeKeyLabel keeps a valid key');
check(schema.safeKeyLabel('a'.repeat(64)) === 'a'.repeat(64), 'safeKeyLabel keeps a 64-char key');
for (const value of ['', 'a b', '1abc', 'a'.repeat(65), '_x', 'a-b', 'key\n', undefined, null, 7, {}, ['apiKey']]) {
  check(schema.safeKeyLabel(value) === '[invalid]', `safeKeyLabel(${JSON.stringify(value)}) is [invalid]`);
}

console.log('\n--- effective defaults (D-12) ---');
const defaults = schema.projectAll({}, {});
checkDeep(Object.keys(defaults), ['settings', 'readOnly'], 'projectAll returns { settings, readOnly }');
checkDeep(Object.keys(defaults.settings), EXPECTED_KEYS, 'projectAll settings keep entry order');
checkDeep(defaults.readOnly, EXPECTED_READ_ONLY, 'projectAll readOnly lists the read-only keys');
check(defaults.settings.showSidepanelProgress === true, 'showSidepanelProgress defaults to true (effective)');
check(defaults.settings.serverUrl === 'https://full-selfbrowsing.com', 'serverUrl defaults to https://full-selfbrowsing.com');
check(defaults.settings.lmstudioBaseUrl === 'http://localhost:1234', 'lmstudioBaseUrl defaults to http://localhost:1234');
check(defaults.settings.customEndpoint === '', 'customEndpoint defaults to empty');
check(defaults.settings.autoAnalyzeMemories === true, 'autoAnalyzeMemories defaults to true');
check(defaults.settings.fsbTelemetryOptOut === false, 'fsbTelemetryOptOut defaults to false');
check(defaults.settings.fsbAgentCap === 8, 'fsbAgentCap falls back to 8 with no recommendation');
check(defaults.settings.maxIterations === 100 && defaults.settings.modelName === 'grok-4-1-fast', 'plain defaults come from the entries');
check(SECRET_KEYS.every((key) => defaults.settings[key] === ''), 'every unset secret reads as empty');
check(schema.projectAll({}, { agentCapRecommendation: 12 }).settings.fsbAgentCap === 12, 'fsbAgentCap uses a recommendation of 12');
for (const rec of [99, 0, 65, 7.5, -1, NaN, Infinity, '12', null]) {
  check(schema.effectiveDefault('fsbAgentCap', { agentCapRecommendation: rec }) === 8, `recommendation ${String(rec)} falls back to 8`);
}
check(schema.effectiveDefault('fsbAgentCap', undefined) === 8, 'a missing ctx falls back to 8');
check(schema.effectiveDefault('fsbAgentCap', { agentCapRecommendation: 1 }) === 1
  && schema.effectiveDefault('fsbAgentCap', { agentCapRecommendation: 64 }) === 64, 'recommendations 1 and 64 are used');
check(schema.effectiveDefault('maxIterations') === 100, 'effectiveDefault returns a plain default');
check(schema.effectiveDefault('nope') === undefined, 'effectiveDefault of an unknown key is undefined');
checkDeep(schema.projectAll(undefined, undefined), defaults, 'projectAll(undefined) equals projectAll({})');
check(schema.projectAll({ fsbAgentCap: 20 }, { agentCapRecommendation: 12 }).settings.fsbAgentCap === 20, 'a stored fsbAgentCap wins over the recommendation');
check(schema.projectValue('debugMode', { debugMode: true }, {}) === true, 'a stored writable value is returned as-is');
check(schema.projectValue('debugMode', { debugMode: undefined }, {}) === false, 'a stored undefined counts as absent');
check(schema.projectValue('debugMode', Object.create({ debugMode: true }), {}) === false, 'an inherited property counts as absent');
check(schema.projectValue('nope', {}, {}) === undefined, 'projectValue of an unknown key is undefined');

console.log('\n--- secrets (D-10) ---');
const SECRET_SENTINEL = 'sk-SENTINEL-abc123';
check(schema.projectValue('apiKey', { apiKey: SECRET_SENTINEL }, {}) === '[set]', 'a stored secret reads as [set]');
check(schema.projectValue('apiKey', { apiKey: '' }, {}) === '', 'an empty secret reads as empty');
check(schema.projectValue('apiKey', { apiKey: '   ' }, {}) === '', 'a blank secret reads as empty');
check(schema.projectValue('apiKey', {}, {}) === '', 'an absent secret reads as empty');
check(schema.projectValue('apiKey', { apiKey: 12345 }, {}) === '', 'a non-string secret reads as empty');
const secretStore = {};
for (const key of SECRET_KEYS) secretStore[key] = SECRET_SENTINEL;
const secretJson = JSON.stringify(schema.projectAll(secretStore, {}));
check(SECRET_KEYS.every((key) => schema.projectAll(secretStore, {}).settings[key] === '[set]'), 'all eight stored secrets read as [set]');
check(!secretJson.includes('SENTINEL'), 'projectAll JSON holds no secret sentinel');
check(!secretJson.includes('sk-'), 'projectAll JSON holds no secret prefix');
check(!secretJson.includes('abc123'), 'projectAll JSON holds no secret suffix');
check(!secretJson.includes(String(SECRET_SENTINEL.length)), 'projectAll JSON holds no stored secret length');
for (const key of SECRET_KEYS) {
  const described = JSON.stringify(schema.describe(key, secretStore, {}));
  check(!described.includes('SENTINEL') && described.includes('"value":"[set]"'), `describe(${key}) masks the secret`);
}

console.log('\n--- endpoints (D-11) ---');
const ENDPOINT_CASES = [
  ['https://user:pw@host.example:8443/v1/chat?k=SECRET#frag', 'https://host.example:8443/...'],
  ['http://localhost:1234', 'http://localhost:1234'],
  ['http://localhost:1234/', 'http://localhost:1234'],
  ['https://h.example?x=1', 'https://h.example/...'],
  ['https://h.example#frag', 'https://h.example/...'],
  ['https://h.example/path', 'https://h.example/...'],
  ['https://h.example:443/', 'https://h.example'],
  ['https://user:pw@h.example', 'https://h.example'],
  ['http://[::1]:1234/v1', 'http://[::1]:1234/...'],
  ['not a url', '[set]'],
  ['javascript:alert(1)', '[set]'],
  ['file:///etc/passwd', '[set]'],
  ['data:text/plain,SECRET', '[set]'],
  ['   ', '[set]'],
  ['', ''],
];
for (const [raw, expected] of ENDPOINT_CASES) {
  const got = schema.originOnly(raw);
  check(got === expected, `originOnly(${JSON.stringify(raw)}) is ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`);
  for (const secret of ['user', 'pw@', 'SECRET', 'frag', 'chat', 'passwd']) {
    if (got.includes(secret)) check(false, `originOnly(${JSON.stringify(raw)}) leaks ${secret}`);
  }
}
for (const value of [undefined, null, 42, {}, ['https://h.example']]) {
  check(schema.originOnly(value) === '', `originOnly(${JSON.stringify(value)}) is empty for a non-string`);
}
const endpointStore = {
  customEndpoint: 'https://user:pw@host.example:8443/v1/chat?k=SECRET#frag',
  lmstudioBaseUrl: 'http://localhost:1234/',
  serverUrl: 'not a url',
};
const endpointRead = schema.projectAll(endpointStore, {});
check(endpointRead.settings.customEndpoint === 'https://host.example:8443/...', 'a stored customEndpoint reads as origin only');
check(endpointRead.settings.lmstudioBaseUrl === 'http://localhost:1234', 'a stored lmstudioBaseUrl reads as origin only');
check(endpointRead.settings.serverUrl === '[set]', 'an unparseable serverUrl reads as [set]');
const endpointJson = JSON.stringify(endpointRead);
check(!/user|pw@|SECRET|frag|chat/.test(endpointJson), 'projectAll JSON holds no userinfo, path, query or fragment token');
check(schema.projectValue('customEndpoint', { customEndpoint: '' }, {}) === '', 'an empty stored endpoint reads as empty');
check(schema.projectValue('serverUrl', {}, {}) === 'https://full-selfbrowsing.com', 'an absent endpoint reads as its effective default origin');

console.log('\n--- reads never write ---');
const frozenStore = Object.freeze({
  apiKey: SECRET_SENTINEL,
  customEndpoint: 'https://h.example/v1?x=1',
  maxIterations: 250,
  debugMode: true,
  sttProvider: 'whisper',
});
const frozenCtx = Object.freeze({ agentCapRecommendation: 12 });
const beforeJson = JSON.stringify(frozenStore);
let readThrew = false;
try {
  schema.projectAll(frozenStore, frozenCtx);
  for (const key of schema.keys()) {
    schema.projectValue(key, frozenStore, frozenCtx);
    schema.describe(key, frozenStore, frozenCtx);
    schema.effectiveDefault(key, frozenCtx);
  }
  schema.describe('nope', frozenStore, frozenCtx);
} catch (_e) {
  readThrew = true;
}
check(!readThrew, 'projectAll, projectValue, describe and effectiveDefault accept a frozen store');
check(JSON.stringify(frozenStore) === beforeJson, 'the stored object is unchanged after every read');
check(schema.projectAll(frozenStore, frozenCtx).settings.maxIterations === 250, 'a stored integer is returned');
check(schema.projectAll(frozenStore, frozenCtx).settings.fsbAgentCap === 12, 'an absent fsbAgentCap uses the ctx recommendation');

console.log('\n--- describe ---');
const describedMax = schema.describe('maxIterations', {}, {});
checkDeep(describedMax, { key: 'maxIterations', value: 100, type: 'integer', writable: true, range: { min: 50, max: 500 } },
  'describe(maxIterations) shows value, type, writable and range');
check(JSON.stringify(describedMax) === '{"key":"maxIterations","value":100,"type":"integer","writable":true,"range":{"min":50,"max":500}}',
  'describe(maxIterations) keeps the wire field order');
checkDeep(schema.describe('sttProvider', {}, {}), { key: 'sttProvider', value: 'browser', type: 'enum', writable: true, values: ['browser', 'whisper'] },
  'describe(sttProvider) lists its values');
checkDeep(schema.describe('apiKey', { apiKey: 'x' }, {}), { key: 'apiKey', value: '[set]', type: 'string', writable: false },
  'describe(apiKey) masks and reports read-only');
checkDeep(schema.describe('serverUrl', {}, {}), { key: 'serverUrl', value: 'https://full-selfbrowsing.com', type: 'string', writable: false },
  'describe(serverUrl) reports origin and read-only');
checkDeep(schema.describe('debugMode', { debugMode: true }, {}), { key: 'debugMode', value: true, type: 'boolean', writable: true },
  'describe(debugMode) reports the stored boolean');
check(schema.describe('fsbAgentCap', {}, { agentCapRecommendation: 16 }).value === 16, 'describe(fsbAgentCap) uses the recommendation');
check(schema.describe('nope', {}, {}) === null, 'describe of an unknown key is null');
check(schema.describe('constructor', {}, {}) === null, 'describe(constructor) is null');
const describedEnum = schema.describe('modelProvider', {}, {});
describedEnum.values.push('mutated');
check(schema.get('modelProvider').values.length === 7, 'describe returns a copy of the values array');

console.log('\n--- parseValue (D-04, D-14) ---');
const C = schema.CODES;
function expectOk(key, raw, value, label) {
  const result = schema.parseValue(key, raw);
  check(isDeepEqual(result, { ok: true, value }), `${label || `parseValue(${key}, ${JSON.stringify(raw)})`} -> ${JSON.stringify(value)} (got ${JSON.stringify(result)})`);
}
function expectFail(key, raw, code, extra, label) {
  const result = schema.parseValue(key, raw);
  const tag = label || `parseValue(${key}, ${JSON.stringify(raw)})`;
  check(result && result.ok === false && result.code === code, `${tag} fails with ${code} (got ${JSON.stringify(result && result.code)})`);
  check(typeof result.error === 'string' && result.error.length > 0, `${tag} carries an error sentence`);
  check(result.key === schema.safeKeyLabel(key), `${tag} labels the key safely`);
  if (extra && extra.range) checkDeep(result.range, extra.range, `${tag} carries the range`);
  if (extra && extra.values) checkDeep(result.values, extra.values, `${tag} carries the allowed values`);
  if (!extra || !extra.range) check(!('range' in result), `${tag} has no range`);
  if (!extra || !extra.values) check(!('values' in result), `${tag} has no values`);
  return result;
}
expectOk('debugMode', 'true', true);
expectOk('debugMode', 'false', false);
for (const raw of ['TRUE', 'True', '1', '0', ' true', 'true ', 'yes', 'on', '']) {
  expectFail('debugMode', raw, C.VALUE_INVALID);
}
expectOk('maxIterations', '50', 50);
expectOk('maxIterations', '500', 500);
expectOk('maxIterations', '250', 250);
expectOk('maxIterations', '000050', 50, 'parseValue(maxIterations, "000050") reads digits as base 10');
const maxRange = { range: { min: 50, max: 500 } };
for (const raw of ['49', '501', '50.0', '-1', '1e2', '0x10', ' 50', '50 ', '', '+50', '5_0', '0000050', '１００', 'Infinity', 'NaN']) {
  expectFail('maxIterations', raw, C.VALUE_INVALID, maxRange);
}
const rangeFailure = schema.parseValue('maxIterations', '600');
check(rangeFailure.error === 'maxIterations must be a whole number from 50 to 500.', 'the integer error states the range');
expectOk('fsbMcpSessionRetentionDays', '365', 365);
expectFail('fsbMcpSessionRetentionDays', '366', C.VALUE_INVALID, { range: { min: 1, max: 365 } });
expectFail('fsbAgentCap', '0', C.VALUE_INVALID, { range: { min: 1, max: 64 } });
expectOk('fsbAgentCap', '64', 64);
expectOk('sttProvider', 'whisper', 'whisper');
expectOk('sttProvider', 'browser', 'browser');
const enumFailure = expectFail('sttProvider', 'Whisper', C.VALUE_INVALID, { values: ['browser', 'whisper'] });
check(enumFailure.error.includes('browser, whisper'), 'the enum error lists the allowed values');
expectFail('sttProvider', ' whisper', C.VALUE_INVALID, { values: ['browser', 'whisper'] });
expectOk('modelProvider', 'lmstudio', 'lmstudio');
expectFail('modelProvider', 'XAI', C.VALUE_INVALID, { values: PROVIDER_IDS });
expectOk('providerKind', 'agent', 'agent');
expectOk('modelName', '  grok-4  ', 'grok-4');
expectOk('modelName', '', '', 'parseValue(modelName, "") accepts an empty string');
expectOk('modelName', 'm'.repeat(200), 'm'.repeat(200), 'parseValue(modelName, 200 chars) accepts the bound');
expectOk('modelName', `  ${'m'.repeat(200)}  `, 'm'.repeat(200), 'parseValue(modelName) trims before the length check');
const longFailure = expectFail('modelName', 'm'.repeat(201), C.VALUE_INVALID, null, 'parseValue(modelName, 201 chars)');
check(longFailure.error.includes('200'), 'the string error states its length bound');
expectOk('agentProviderId', 'claude-code', 'claude-code');
expectFail('agentProviderId', 'a'.repeat(65), C.VALUE_INVALID, null, 'parseValue(agentProviderId, 65 chars)');
expectFail('modelName', 'm'.repeat(2049), C.VALUE_INVALID, null, 'parseValue(modelName, 2049 chars)');
expectFail('debugMode', 't'.repeat(2049), C.VALUE_INVALID, null, 'parseValue(debugMode, 2049 chars)');
for (const raw of [true, false, 5, null, undefined, {}, ['true'], Symbol.iterator]) {
  expectFail('debugMode', raw, C.REQUEST_INVALID, null, `parseValue(debugMode, ${typeof raw})`);
}
expectFail('maxIterations', 100, C.REQUEST_INVALID, null, 'parseValue(maxIterations, number 100)');
expectFail('nope', 'true', C.UNKNOWN_KEY);
expectFail('constructor', 'true', C.UNKNOWN_KEY);
expectFail('', 'true', C.UNKNOWN_KEY);
expectFail(42, 'true', C.UNKNOWN_KEY, null, 'parseValue(42, "true")');
check(schema.parseValue('a b', 'true').key === '[invalid]', 'an invalid key is labelled [invalid]');
for (const key of [...SECRET_KEYS, ...ENDPOINT_KEYS]) {
  expectFail(key, 'https://h.example', C.PROTECTED_KEY);
}

console.log('\n--- value-free failures ---');
const RAW_MARK = 'SENTINEL-raw';
const sentinelCases = [
  ['debugMode', RAW_MARK],
  ['debugMode', `true${RAW_MARK}`],
  ['maxIterations', RAW_MARK],
  ['maxIterations', `5${RAW_MARK}`],
  ['sttProvider', RAW_MARK],
  ['modelProvider', RAW_MARK],
  ['providerKind', RAW_MARK],
  ['modelName', `${'x'.repeat(201)}${RAW_MARK}`],
  ['agentProviderId', `${'x'.repeat(64)}${RAW_MARK}`],
  ['modelName', RAW_MARK.repeat(200)],
  ['apiKey', RAW_MARK],
  ['serverHashKey', RAW_MARK],
  ['customEndpoint', `https://${RAW_MARK}.example/`],
  ['serverUrl', `https://${RAW_MARK}.example/`],
  ['nope', RAW_MARK],
  [`${RAW_MARK} key`, RAW_MARK],
];
for (const [key, raw] of sentinelCases) {
  const result = schema.parseValue(key, raw);
  check(result.ok === false, `parseValue(${schema.safeKeyLabel(key)}, <sentinel>) fails`);
  check(!result.error.includes('SENTINEL'), `parseValue(${schema.safeKeyLabel(key)}, <sentinel>) error omits the raw value`);
  check(!JSON.stringify(result).includes('SENTINEL'), `parseValue(${schema.safeKeyLabel(key)}, <sentinel>) failure object omits the raw value`);
}

console.log('\n--- fixture factory (D-17) ---');
const FIXTURE_KEY = 'fsbSchemaFixtureFlag';
const fixture = schema.create([
  ...schema.entries,
  { key: FIXTURE_KEY, type: 'boolean', cls: 'writable', default: false },
]);
check(fixture !== schema, 'create returns a new instance');
check(Object.isFrozen(fixture) && Object.isFrozen(fixture.entries), 'the fixture instance and its entries are frozen');
check(fixture.keys().includes(FIXTURE_KEY), 'the fixture schema lists the fixture key');
check(fixture.keys().length === 36, 'the fixture schema has 36 keys');
check(!schema.keys().includes(FIXTURE_KEY) && schema.get(FIXTURE_KEY) === null, 'the production schema does not see the fixture key');
check(schema.keys().length === 35, 'the production schema still has 35 keys');
check(fixture.isWritable(FIXTURE_KEY) === true, 'the fixture key is writable');
check(fixture.projectAll({}, {}).settings[FIXTURE_KEY] === false, 'the fixture key reads its default');
check(fixture.projectAll({ [FIXTURE_KEY]: true }, {}).settings[FIXTURE_KEY] === true, 'the fixture key reads a stored value');
checkDeep(fixture.parseValue(FIXTURE_KEY, 'true'), { ok: true, value: true }, 'the fixture key parses a write');
checkDeep(fixture.describe(FIXTURE_KEY, {}, {}), { key: FIXTURE_KEY, value: false, type: 'boolean', writable: true }, 'the fixture key describes itself');
check(schema.parseValue(FIXTURE_KEY, 'true').code === C.UNKNOWN_KEY, 'the production schema refuses the fixture key');
for (const name of ['CODES', 'KEY_PATTERN', 'VALUE_MAX_LENGTH', 'PROVIDERS', 'MODEL_LIST_CAP', 'safeKeyLabel', 'originOnly', 'create']) {
  check(fixture[name] === schema[name], `the fixture instance carries the static ${name}`);
}
const nested = fixture.create([{ key: 'onlyKey', type: 'integer', cls: 'writable', default: 3, min: 1, max: 5 }]);
checkDeep(nested.keys(), ['onlyKey'], 'a fixture instance can create another schema');
checkDeep(nested.parseValue('onlyKey', '6'), {
  ok: false, code: C.VALUE_INVALID, error: 'onlyKey must be a whole number from 1 to 5.', key: 'onlyKey', range: { min: 1, max: 5 },
}, 'a fixture integer entry enforces its own bounds');
const fixtureSource = [{ key: 'sourceKey', type: 'enum', cls: 'writable', default: 'a', values: ['a', 'b'] }];
const fromSource = schema.create(fixtureSource);
fixtureSource[0].values.push('c');
fixtureSource.push({ key: 'late', type: 'boolean', cls: 'writable', default: true });
checkDeep(fromSource.keys(), ['sourceKey'], 'create copies its input array');
checkDeep([...fromSource.get('sourceKey').values], ['a', 'b'], 'create copies nested arrays');
check(!Object.isFrozen(fixtureSource[0]), 'create does not freeze the caller\'s objects');
const BAD_ENTRIES = [
  ['a non-array', 'nope'],
  ['a non-object entry', ['x']],
  ['an invalid key', [{ key: '1bad', type: 'boolean', cls: 'writable', default: true }]],
  ['a duplicate key', [{ key: 'dup', type: 'boolean', cls: 'writable', default: true }, { key: 'dup', type: 'boolean', cls: 'writable', default: false }]],
  ['an unknown field', [{ key: 'k', type: 'boolean', cls: 'writable', default: true, extra: 1 }]],
  ['an unknown type', [{ key: 'k', type: 'number', cls: 'writable', default: 1 }]],
  ['an unknown class', [{ key: 'k', type: 'boolean', cls: 'hidden', default: true }]],
  ['a non-string secret', [{ key: 'k', type: 'boolean', cls: 'secret', default: false }]],
  ['an integer default outside its bounds', [{ key: 'k', type: 'integer', cls: 'writable', default: 9, min: 1, max: 5 }]],
  ['an integer without bounds', [{ key: 'k', type: 'integer', cls: 'writable', default: 1 }]],
  ['an enum default outside its values', [{ key: 'k', type: 'enum', cls: 'writable', default: 'z', values: ['a'] }]],
  ['an enum without values', [{ key: 'k', type: 'enum', cls: 'writable', default: 'a' }]],
  ['a boolean with a string default', [{ key: 'k', type: 'boolean', cls: 'writable', default: 'true' }]],
  ['min on a boolean', [{ key: 'k', type: 'boolean', cls: 'writable', default: true, min: 1 }]],
  ['maxLength on an integer', [{ key: 'k', type: 'integer', cls: 'writable', default: 1, min: 1, max: 2, maxLength: 3 }]],
  ['an unknown group', [{ key: 'k', type: 'boolean', cls: 'writable', default: true, group: 'other' }]],
  ['an unknown computed default', [{ key: 'k', type: 'integer', cls: 'writable', default: { from: 'elsewhere' }, min: 1, max: 64 }]],
];
for (const [label, entries] of BAD_ENTRIES) {
  check(throwsTypeError(() => schema.create(entries)), `create rejects ${label}`);
}
check(schema.keys().length === 35, 'rejected create calls leave the production schema untouched');

console.log('\n--- config.js scope safety ---');
const topLevel = CONFIG_SOURCE.split('\n').filter((line) => /^(const|let|class|function|var) /.test(line));
checkDeep(topLevel.map((line) => line.split(/[\s=({]/).slice(0, 2).join(' ')), ['class Config', 'const config'],
  'config.js declares only class Config and const config at top level');
check((CONFIG_SOURCE.match(/global\.FsbSettingsSchema\s*=/g) || []).length === 1, 'config.js assigns global.FsbSettingsSchema once');
check(/module\.exports\.FsbSettingsSchema\s*=/.test(CONFIG_SOURCE), 'config.js adds FsbSettingsSchema to module.exports');
check(CONFIG_SOURCE.includes('module.exports = { Config, config };'), 'config.js keeps its original export line');
check(/providerKind/.test(CONFIG_SOURCE), 'config.js keeps the providerKind token (delegation-phase-contract pin)');
check(!/chrome\.storage\.local\.(get|set)/.test(CONFIG_SOURCE.slice(CONFIG_SOURCE.indexOf('module.exports = { Config, config };'))),
  'the schema block never touches chrome.storage');

// Control panel: options.js declares `const defaultSettings` in the same scope.
const panelContext = vm.createContext({ console, URL });
vm.runInContext('var window = globalThis; const defaultSettings = {};', panelContext);
let panelError = null;
try {
  vm.runInContext(CONFIG_SOURCE, panelContext, { filename: 'config.js' });
} catch (err) {
  panelError = err;
}
check(panelError === null, `config.js loads in a panel-like scope that already declared defaultSettings${panelError ? ` (${panelError.message})` : ''}`);
check(vm.runInContext('typeof defaultSettings === "object" && typeof FsbSettingsSchema === "object" && window.FsbSettingsSchema === FsbSettingsSchema', panelContext),
  'the panel scope exposes FsbSettingsSchema next to defaultSettings');

// Service worker: `self` is the global; config.js loads before the SW-only modules.
let chromeCalls = 0;
const swChrome = {
  storage: {
    onChanged: { addListener() { chromeCalls += 1; } },
    local: {
      get() { throw new Error('schema load must not read storage'); },
      set() { throw new Error('schema load must not write storage'); },
    },
  },
};
const swContext = vm.createContext({ console, URL, chrome: swChrome });
vm.runInContext('var self = globalThis;', swContext);
let swError = null;
try {
  vm.runInContext(CONFIG_SOURCE, swContext, { filename: 'config.js' });
} catch (err) {
  swError = err;
}
check(swError === null, `config.js loads in an SW-like scope${swError ? ` (${swError.message})` : ''}`);
check(vm.runInContext('self.FsbSettingsSchema.keys().length', swContext) === 35, 'the SW scope exposes self.FsbSettingsSchema');
check(vm.runInContext('typeof FsbAgentCapRecommendation === "undefined" && typeof FsbDelegationProviders === "undefined"', swContext),
  'config.js does not need the SW-only globals at load');
check(chromeCalls === 1, 'loading config.js makes only the Config cache listener chrome call');
check(vm.runInContext('self.FsbSettingsSchema.projectAll({ apiKey: "k", lmstudioBaseUrl: "http://127.0.0.1:1234/v1" }, {}).settings.lmstudioBaseUrl', swContext)
  === 'http://127.0.0.1:1234/...', 'reads work in the SW scope without chrome.storage');
let laterScriptError = null;
try {
  vm.runInContext([
    'const PRODUCTION_ENTRIES = 1; const CODES = 1; const KEY_PATTERN = 1; const PROVIDERS = 1;',
    'const create = 1; const originOnly = 1; const safeKeyLabel = 1; const api = 1; const STATICS = 1;',
    'const buildEntry = 1; const failure = 1; const VALUE_MAX_LENGTH = 1; const MODEL_LIST_CAP = 1;',
  ].join('\n'), swContext, { filename: 'later-importScripts-module.js' });
} catch (err) {
  laterScriptError = err;
}
check(laterScriptError === null, `a later SW script can declare the schema's internal names${laterScriptError ? ` (${laterScriptError.message})` : ''}`);

// A context without URL (never the SW or panel) still masks endpoints.
const noUrlContext = vm.createContext({ console });
vm.runInContext(CONFIG_SOURCE, noUrlContext, { filename: 'config.js' });
check(vm.runInContext('FsbSettingsSchema.originOnly("https://user:pw@h.example/x")', noUrlContext) === '[set]',
  'originOnly fails closed to [set] when URL is unavailable');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
