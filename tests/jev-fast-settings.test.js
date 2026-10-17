'use strict';

/**
 * Phase 68 Plan 01 (AUTO-01, D-04) -- the fast-mode switch as one settings key.
 *
 * fsbJevFastModeEnabled is one writable boolean FsbSettingsSchema entry,
 * default false, with the same false default in Config.defaults,
 * init-config.js and options.js defaultSettings. The control panel loads,
 * saves and live-refreshes it the way it handles fsbChangeReportsEnabled, and
 * nothing reads it at run time yet. The checkbox and its disclosure card land
 * in plan 68-12, so every panel site here must tolerate a missing element.
 *
 * Sections:
 *   - schema: the entry, its position, the 36/25/11 counts and parseValue;
 *   - default copies: the three copies hold false, so D-12 parity adds no
 *     divergence;
 *   - options.js wiring: source regexes in the style of
 *     tests/change-report-settings-ui.test.js;
 *   - panel sync: FSBSettingsSync loaded under the tests/settings-panel-sync
 *     DOM shim (refresh in place, no event, Save never reverts an external
 *     write, a user edit wins).
 * Plan 68-12 adds the card and copy sections.
 *
 * No network, no ports. Node 20-safe.
 *
 * Run: node tests/jev-fast-settings.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const KEY = 'fsbJevFastModeEnabled';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log('  PASS:', msg); }
  else { failed += 1; console.error('  FAIL:', msg); }
}

function section(title) {
  console.log('\n--- ' + title + ' ---');
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readRepo(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return null;
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end === -1) return null;
  return text.slice(start, end);
}

const OPTIONS_PATH = path.join(ROOT, 'extension', 'ui', 'options.js');
const OPTIONS_SOURCE = readRepo('extension/ui/options.js');
const INIT_CONFIG_SOURCE = readRepo('extension/config/init-config.js');
const SCHEMA_TEST_SOURCE = readRepo('tests/settings-schema.test.js');

// ---------------------------------------------------------------------------
// DOM shim (the tests/settings-panel-sync.test.js harness, reduced)
// ---------------------------------------------------------------------------

let dispatchCount = 0;
let fetchCalls = 0;

function makeEl(tagName, id) {
  return {
    tagName: String(tagName || 'div').toUpperCase(),
    id: id || '',
    children: [],
    attributes: {},
    classList: {
      _set: new Set(),
      add(...names) { names.forEach((n) => this._set.add(n)); },
      remove(...names) { names.forEach((n) => this._set.delete(n)); },
      contains(n) { return this._set.has(n); },
      toggle(n, on) { if (on) this.add(n); else this.remove(n); }
    },
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    style: {},
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    addEventListener() {},
    querySelector() { return null; },
    dispatchEvent() { dispatchCount += 1; return true; }
  };
}

const registry = new Map();

function buildRegistry(withSwitch) {
  registry.clear();
  for (const id of ['debugMode', 'fsbChangeReportsEnabled']) {
    const el = makeEl('input', id);
    el.type = 'checkbox';
    registry.set(id, el);
  }
  if (withSwitch) {
    const el = makeEl('input', KEY);
    el.type = 'checkbox';
    registry.set(KEY, el);
  }
}

function installShims() {
  buildRegistry(true);
  global.document = {
    readyState: 'complete',
    getElementById: (id) => registry.get(id) || null,
    createElement: (tag) => makeEl(tag),
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => []
  };
  global.chrome = {
    storage: {
      local: {
        get: (_keys, cb) => { if (typeof cb === 'function') cb({}); return Promise.resolve({}); },
        set: (_obj, cb) => { if (typeof cb === 'function') cb(); return Promise.resolve(); }
      },
      onChanged: { addListener: () => {} }
    },
    runtime: {
      sendMessage: () => Promise.resolve({}),
      getManifest: () => ({ version: '0.0.0' })
    }
  };
  global.window = global;
  global.FSBAnalytics = function () {
    return { addEventListener: () => {}, refreshAnalytics: () => {}, getStats: () => ({}) };
  };
  global.fetch = function () {
    fetchCalls += 1;
    throw new Error('jev-fast-settings: network is forbidden in this test');
  };
}

function simpleDeps() {
  const noop = () => undefined;
  const deps = { getElement: (id) => registry.get(id) || null };
  for (const name of ['refreshStepper', 'setAgentCap', 'setPersistedVoiceInputEnabled', 'getProviderState',
    'getPersistedProviderSelection', 'setPersistedProviderSelection', 'normalizeProviderSettings',
    'invalidateDiscovery', 'updateApiKeyVisibility', 'updateModelDescription', 'setDiscoveryStatus',
    'setControlsDisabled', 'refreshCombobox', 'renderProviderKind', 'syncSelectLabels', 'createOption']) {
    deps[name] = noop;
  }
  return deps;
}

// The onboarding-first-run harness on init-config's production branch (the
// tests/settings-schema.test.js D-12 harness): the install patch is what a
// fresh production install stores.
async function loadInitConfigProductionDefaults() {
  const storageSets = [];
  let installListener = null;
  const context = {
    console,
    window: {},
    chrome: {
      runtime: {
        getManifest: () => ({ version: '0.0.0-test', update_url: 'https://clients2.google.com/service/update2/crx' }),
        getURL: (rel) => 'chrome-extension://fsb/' + rel,
        onInstalled: { addListener: (fn) => { installListener = fn; } }
      },
      storage: {
        local: {
          get: async () => ({}),
          set: async (patch) => { storageSets.push(patch); }
        }
      },
      tabs: { create: async () => {} }
    }
  };
  vm.runInNewContext(INIT_CONFIG_SOURCE, context, { filename: 'init-config.js' });
  if (typeof installListener !== 'function') return { patch: null, defaultConfig: null };
  await installListener({ reason: 'install' });
  const patch = storageSets.find((set) => set && Object.prototype.hasOwnProperty.call(set, 'modelProvider')) || null;
  const defaultConfig = context.window.initConfig ? context.window.initConfig.defaultConfig : null;
  return { patch, defaultConfig };
}

function loadOptionsDefaultSettings() {
  const literal = sliceBetween(OPTIONS_SOURCE, 'const defaultSettings = {', '\n};\n');
  if (literal === null) return null;
  return vm.runInNewContext('(' + literal.slice('const defaultSettings = '.length) + '\n})', {}, { filename: 'options.js defaultSettings' });
}

(async () => {
  console.log('--- Phase 68 Plan 01: the fast-mode switch (fsbJevFastModeEnabled) ---');

  const configModule = require('../extension/config/config.js');
  const schema = configModule.FsbSettingsSchema;

  // -------------------------------------------------------------------------
  section('schema');
  // -------------------------------------------------------------------------
  const entry = schema.get(KEY);
  ok(entry !== null && sameJson({ ...entry }, { key: KEY, type: 'boolean', cls: 'writable', default: false }),
    'FsbSettingsSchema.get(fsbJevFastModeEnabled) is {key, type:boolean, cls:writable, default:false}');
  const keys = schema.keys();
  ok(keys[keys.length - 1] === KEY, 'fsbJevFastModeEnabled is the last schema entry');
  ok(keys.length === 36, 'keys().length is 36 (got ' + keys.length + ')');
  ok(keys.filter((k) => schema.isWritable(k)).length === 25, '25 keys are writable');
  ok(schema.isWritable(KEY) === true, 'fsbJevFastModeEnabled is writable over MCP');
  ok(schema.readOnlyKeys().length === 11 && !schema.readOnlyKeys().includes(KEY), 'readOnlyKeys() stays at 11 and excludes the switch');
  ok(sameJson(schema.parseValue(KEY, 'true'), { ok: true, value: true }), "parseValue(fsbJevFastModeEnabled, 'true') is {ok:true, value:true}");
  ok(sameJson(schema.parseValue(KEY, 'false'), { ok: true, value: false }), "parseValue(fsbJevFastModeEnabled, 'false') is {ok:true, value:false}");
  const yes = schema.parseValue(KEY, 'yes');
  ok(yes && yes.ok === false && yes.code === schema.CODES.VALUE_INVALID, "parseValue(fsbJevFastModeEnabled, 'yes') fails VALUE_INVALID");
  ok(schema.projectAll({}, {}).settings[KEY] === false, 'an empty store reads the switch as false');
  ok(!keys.includes('speedMode') && !keys.includes('fsbFixtureFastMode'), 'neither speedMode nor the fsbFixtureFastMode fixture is a production key');

  // -------------------------------------------------------------------------
  section('default copies');
  // -------------------------------------------------------------------------
  const ConfigClass = configModule.Config;
  ok(new ConfigClass().defaults[KEY] === false, 'new Config().defaults.fsbJevFastModeEnabled === false');
  const init = await loadInitConfigProductionDefaults();
  ok(init.patch !== null && init.patch[KEY] === false, "init-config.js's production install patch holds fsbJevFastModeEnabled: false");
  ok(init.defaultConfig !== null && init.defaultConfig[KEY] === false, 'init-config.js defaultConfig holds fsbJevFastModeEnabled: false');
  const optionsDefaults = loadOptionsDefaultSettings();
  ok(optionsDefaults !== null && optionsDefaults[KEY] === false, 'options.js defaultSettings.fsbJevFastModeEnabled === false');
  const divergences = sliceBetween(SCHEMA_TEST_SOURCE, 'const KNOWN_DEFAULT_DIVERGENCES = {', '\n};\n');
  ok(divergences !== null && !divergences.includes(KEY), 'KNOWN_DEFAULT_DIVERGENCES gains no entry for the switch');

  // -------------------------------------------------------------------------
  section('options.js wiring');
  // -------------------------------------------------------------------------
  const defaultsLiteral = sliceBetween(OPTIONS_SOURCE, 'const defaultSettings = {', '\n};\n') || '';
  ok(/\n\s*fsbJevFastModeEnabled\s*:\s*false\s*,/.test(defaultsLiteral), 'defaultSettings declares fsbJevFastModeEnabled: false');
  ok(/elements\.fsbJevFastModeEnabled\s*=\s*document\.getElementById\(['"]fsbJevFastModeEnabled['"]\)/.test(OPTIONS_SOURCE),
    'cacheElements wires elements.fsbJevFastModeEnabled');
  ok(/if \(elements\.fsbJevFastModeEnabled\) \{\s*elements\.fsbJevFastModeEnabled\.addEventListener\(['"]change['"],\s*\(\)\s*=>\s*\{\s*markUnsavedChanges\(\);/.test(OPTIONS_SOURCE),
    'setupEventListeners attaches a null-guarded change handler that calls markUnsavedChanges()');
  ok(/if \(elements\.fsbJevFastModeEnabled\) \{\s*elements\.fsbJevFastModeEnabled\.checked = settings\.fsbJevFastModeEnabled \?\? false;\s*\}/.test(OPTIONS_SOURCE),
    'loadSettings sets .checked = settings.fsbJevFastModeEnabled ?? false inside a null guard');
  const saveBody = sliceBetween(OPTIONS_SOURCE, 'function saveSettings() {', 'function discardChanges() {') || '';
  const saveObject = sliceBetween(saveBody, '  const settings = {\n', '\n  };\n') || '';
  ok(saveObject.split('\n    fsbJevFastModeEnabled: elements.fsbJevFastModeEnabled?.checked ?? false,').length - 1 === 1,
    'saveSettings writes fsbJevFastModeEnabled: elements.fsbJevFastModeEnabled?.checked ?? false exactly once');
  ok(/fsbChangeReportsEnabled: elements\.fsbChangeReportsEnabled\?\.checked \?\? true,\n\s*fsbJevFastModeEnabled: elements\.fsbJevFastModeEnabled\?\.checked \?\? false,/.test(saveObject),
    'the save line sits right after the fsbChangeReportsEnabled line');
  ok(OPTIONS_SOURCE.split("    fsbJevFastModeEnabled: (value, deps) => setControlChecked(deps, 'fsbJevFastModeEnabled', value === true),").length - 1 === 1,
    'FIELD_REFRESHERS holds one fsbJevFastModeEnabled refresher (checked only for a stored true)');
  ok(OPTIONS_SOURCE.split('\n').filter((line) => line.includes('speedMode') && line.includes(KEY)).length === 0,
    'no speedMode line mentions the switch');
  ok((OPTIONS_SOURCE.match(/fsbJevFastModeEnabled/g) || []).length >= 5, 'options.js names the switch at least five times');

  // -------------------------------------------------------------------------
  section('panel sync (FSBSettingsSync)');
  // -------------------------------------------------------------------------
  global.FsbSettingsSchema = schema;
  global.config = {
    availableModels: { xai: [], gemini: [], openai: [], anthropic: [], openrouter: [], lmstudio: [] }
  };
  delete require.cache[require.resolve(OPTIONS_PATH)];
  installShims();
  require(OPTIONS_PATH);
  const sync = global.FSBSettingsSync;
  ok(sync !== null && typeof sync === 'object', 'requiring options.js exposes FSBSettingsSync');

  ok(sync.keyForElementId(KEY) === KEY, 'keyForElementId(fsbJevFastModeEnabled) -> fsbJevFastModeEnabled (no alias)');

  sync.reset({ [KEY]: false });
  const changed = sync.noteStorageChanges({ [KEY]: { oldValue: false, newValue: true } }, 'local');
  ok(sameJson(changed.apply, { [KEY]: true }), 'an untouched external write is applied: apply is {fsbJevFastModeEnabled: true}');

  buildRegistry(true);
  dispatchCount = 0;
  const applied = sync.applyToForm(changed.apply, simpleDeps());
  ok(sameJson(applied, [KEY]), 'applyToForm refreshes the switch in place');
  ok(registry.get(KEY).checked === true, 'the checkbox is now checked');
  ok(dispatchCount === 0, 'the refresh dispatches no event');

  const builtWhileUnchecked = { debugMode: false, [KEY]: false };
  const dropped = sync.filterForSave(builtWhileUnchecked);
  ok(dropped.includes(KEY) && !Object.prototype.hasOwnProperty.call(builtWhileUnchecked, KEY),
    'filterForSave deletes the switch from a Save built while the box was still unchecked (Save never reverts it)');

  sync.reset({ [KEY]: false });
  sync.noteTouched(KEY);
  const touchedChange = sync.noteStorageChanges({ [KEY]: { oldValue: false, newValue: true } }, 'local');
  ok(sameJson(touchedChange.apply, {}), 'after noteTouched the external write is not applied');
  const userEdit = { [KEY]: false };
  ok(sync.filterForSave(userEdit).length === 0 && userEdit[KEY] === false, "after noteTouched the user's edit wins at Save");

  buildRegistry(true);
  registry.get(KEY).checked = true;
  sync.applyToForm({ [KEY]: undefined }, simpleDeps());
  ok(registry.get(KEY).checked === false, 'a removed key refreshes to the default (unchecked)');
  registry.get(KEY).checked = true;
  sync.applyToForm({ [KEY]: 'yes' }, simpleDeps());
  ok(registry.get(KEY).checked === false, 'only a stored boolean true checks the box');

  buildRegistry(false);
  let threw = null;
  let appliedWithoutElement = null;
  try {
    appliedWithoutElement = sync.applyToForm({ [KEY]: true }, simpleDeps());
  } catch (error) {
    threw = error;
  }
  ok(threw === null && sameJson(appliedWithoutElement, [KEY]), 'with no checkbox in the page (before plan 68-12) the refresh is a safe no-op');
  ok(fetchCalls === 0, 'no network call was made');
  sync.reset({});

  // -------------------------------------------------------------------------
  section('registration');
  // -------------------------------------------------------------------------
  const pkg = JSON.parse(readRepo('package.json'));
  ok(pkg.scripts.test.split(' && ').filter((cmd) => cmd === 'node tests/jev-fast-settings.test.js').length === 1,
    'package.json test chain runs this suite exactly once');
  const contract = readRepo('tests/delegation-phase-contract.test.js');
  ok(contract.split("'node tests/jev-fast-settings.test.js',").length - 1 === 1,
    'REFINEMENT_ROOT_TEST_COMMANDS lists this suite exactly once');

  console.log('\nPASS=' + passed + ' FAIL=' + failed);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
