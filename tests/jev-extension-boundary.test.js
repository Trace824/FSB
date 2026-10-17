#!/usr/bin/env node
'use strict';

/**
 * Phase 67 Plan 11 -- the Jev extension boundary (D-01, D-09, D-17, D-22;
 * JEV-01, JEV-02).
 *
 * The extension bundle is public, so everything in it can be read by anyone.
 * This suite proves four things about it:
 *
 *   1. No upstream path or credential name. No file under extension/ (any
 *      extension, comments included, binaries read as latin1) contains
 *      `systemone`, `api.typesafe.ai` or a `JEV_*` env-var name. The string
 *      `openrouter.ai` is allowed: it is the existing chat provider.
 *   2. One fixed endpoint, no storage. extension/ai/jev-*.js contain no
 *      chrome.storage, localStorage, serverUrl or importScripts, and the only
 *      URL in them is https://full-selfbrowsing.com/api/jev/decide, exactly
 *      once, in jev-client.js.
 *   3. No caller, no setting, no UI. Nothing outside extension/ai/jev-*.js
 *      names FsbJevState, FsbJevClient or FsbJevPolicy; background.js names
 *      only the three file names, in its three load lines; nothing under
 *      extension/ui or extension/config mentions jev, except the one settings
 *      key fsbJevFastModeEnabled (Phase 68 D-06), allowed as an exact,
 *      word-bounded token in extension/config/config.js,
 *      extension/config/init-config.js and extension/ui/options.js only. Any
 *      other jev text in those files, or the token anywhere else under
 *      extension/ui or extension/config, still fails.
 *   4. Inert load. Each module, alone and all three together, evaluates in a
 *      bare vm context (no chrome, no fetch, no require, no module), makes no
 *      timer call, logs nothing, throws nothing and adds exactly its own
 *      Fsb* global. In that context a client is created and an invalid
 *      request is answered invalid_request without fetch.
 *
 * A violation is a defect in the module's owning plan (67-06, 67-07 or
 * 67-08). Fix the module; never weaken this suite.
 *
 * Run: node tests/jev-extension-boundary.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// A promise that never settles must not pass as a clean exit.
process.exitCode = 1;

const ROOT = path.join(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const AI_DIR = path.join(EXT_DIR, 'ai');
const MAX_SCAN_BYTES = 5 * 1024 * 1024;
const ENDPOINT = 'https://full-selfbrowsing.com/api/jev/decide';

// Load order matches extension/background.js: state, client, policy.
const MODULES = Object.freeze([
  Object.freeze({ file: 'jev-state.js', global: 'FsbJevState' }),
  Object.freeze({ file: 'jev-client.js', global: 'FsbJevClient' }),
  Object.freeze({ file: 'jev-policy.js', global: 'FsbJevPolicy' })
]);
const JEV_GLOBALS = MODULES.map((m) => m.global);
const JEV_REL_PATHS = MODULES.map((m) => 'extension/ai/' + m.file);

// D-01, D-09, D-22: patterns forbidden anywhere in extension/.
const TREE_PATTERNS = Object.freeze([
  Object.freeze({ name: 'systemone (upstream path)', re: /systemone/gi }),
  Object.freeze({ name: 'api.typesafe.ai (upstream host)', re: /api\.typesafe\.ai/gi }),
  Object.freeze({ name: 'JEV_* credential env-var name', re: /\bJEV_[A-Z_]+\b/g })
]);

// D-01, D-09: patterns forbidden in extension/ai/jev-*.js.
const MODULE_PATTERNS = Object.freeze([
  Object.freeze({ name: 'chrome.storage', re: /chrome\.storage/g }),
  Object.freeze({ name: 'localStorage', re: /localStorage/g }),
  Object.freeze({ name: 'serverUrl (user-editable Sync server URL)', re: /serverUrl/gi }),
  Object.freeze({ name: 'importScripts', re: /importScripts/g })
]);

// D-01: no caller of the Jev globals outside the modules themselves.
const CALLER_PATTERN = Object.freeze({ name: 'FsbJev* global reference', re: /FsbJev[A-Za-z_$]*/g });

// D-01: no Jev setting, storage key or UI.
const UI_WORD_PATTERN = Object.freeze({ name: 'jev (word)', re: /\bjev\b/gi });
const UI_TEXT_PATTERN = Object.freeze({ name: 'jev (any substring, text files)', re: /jev/gi });

// Phase 68 D-06: the exact settings keys a text file under extension/ui or
// extension/config may contain, and the only files that may contain them.
// Each token is removed only where it stands as a whole word, and only in
// those files, before UI_TEXT_PATTERN runs; any other jev text still fails.
const UI_CONFIG_JEV_TOKENS = Object.freeze(['fsbJevFastModeEnabled']);
const UI_CONFIG_TOKEN_FILES = Object.freeze([
  'extension/config/config.js',
  'extension/config/init-config.js',
  'extension/ui/options.js'
]);

// Any scheme://... literal (https, http, ws, wss, chrome-extension, ...).
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)<>\]]*/gi;

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log('  PASS: ' + message);
  } else {
    failed += 1;
    console.error('  FAIL: ' + message);
  }
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

/** Every regular file under dir, recursively; node_modules and symlinks are skipped. */
function walkFiles(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Read a file for scanning. Text is read as UTF-8; a file holding a NUL byte
 * is treated as binary and read as latin1, so ASCII patterns still match
 * byte-for-byte. Files over 5 MB are skipped and reported.
 */
function readForScan(file) {
  const size = fs.statSync(file).size;
  if (size > MAX_SCAN_BYTES) return { skipped: true, size };
  const buf = fs.readFileSync(file);
  const binary = buf.indexOf(0) !== -1;
  return { skipped: false, binary, text: buf.toString(binary ? 'latin1' : 'utf8') };
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Every match of pattern in text as {line, match}. */
function findAll(text, pattern) {
  const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : pattern.re.flags + 'g');
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    hits.push({ line: lineOf(text, m.index), match: m[0] });
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return hits;
}

function report(violations, label) {
  if (violations.length === 0) return;
  console.error('  ' + label + ' violations:');
  for (const v of violations) console.error('    - ' + v.file + ':' + v.line + ' -- ' + v.pattern + ' (' + JSON.stringify(v.match) + ')');
}

/** text with every whole-word UI_CONFIG_JEV_TOKENS occurrence removed (line breaks kept). */
function stripAllowedTokens(text) {
  let out = text;
  for (const token of UI_CONFIG_JEV_TOKENS) out = out.replace(new RegExp('\\b' + token + '\\b', 'g'), '');
  return out;
}

/**
 * The UI_TEXT_PATTERN hits in one text file under extension/ui or
 * extension/config (relPath is repo-relative). The allowed tokens are removed
 * first only in UI_CONFIG_TOKEN_FILES, so the scan stays as strict everywhere
 * else and for every other jev text.
 */
function uiTextHits(text, relPath) {
  const scanned = UI_CONFIG_TOKEN_FILES.includes(relPath) ? stripAllowedTokens(text) : text;
  return findAll(scanned, UI_TEXT_PATTERN);
}

// ---------------------------------------------------------------------------
// Static scans
// ---------------------------------------------------------------------------

function scannerSelfTest() {
  console.log('\n--- scanner self-test (the patterns can fire) ---');
  const planted = [
    ['const upstream = "https://api.typesafe.ai/v1/systemone/decide";', ['systemone (upstream path)', 'api.typesafe.ai (upstream host)']],
    ['process.env.JEV_API_KEY', ['JEV_* credential env-var name']],
    ['JEV_UPSTREAM_URL=x', ['JEV_* credential env-var name']],
    ['SYSTEMONE', ['systemone (upstream path)']]
  ];
  for (const [text, expected] of planted) {
    const fired = TREE_PATTERNS.filter((p) => findAll(text, p).length > 0).map((p) => p.name);
    check(JSON.stringify(fired) === JSON.stringify(expected), 'planted ' + JSON.stringify(text) + ' fires exactly ' + expected.join(', '));
  }
  const allowed = ['https://openrouter.ai/api/v1/chat/completions', 'jev_requires_confirmation', 'FsbJevState'];
  for (const text of allowed) {
    check(TREE_PATTERNS.every((p) => findAll(text, p).length === 0), JSON.stringify(text) + ' is not a tree-scan violation');
  }
  check(findAll('chrome.storage.local.get', MODULE_PATTERNS[0]).length === 1
    && findAll('cfg.serverURL', MODULE_PATTERNS[2]).length === 1
    && findAll('self.importScripts(x)', MODULE_PATTERNS[3]).length === 1,
  'module patterns fire on chrome.storage, serverURL and importScripts');
  check(findAll('FsbJevClient.decide(r)', CALLER_PATTERN).length === 1, 'caller pattern fires on FsbJevClient.decide');
  check(findAll('<label>Jev fast mode</label>', UI_WORD_PATTERN).length === 1
    && findAll('jevFastMode: false', UI_WORD_PATTERN).length === 0
    && findAll('jevFastMode: false', UI_TEXT_PATTERN).length === 1,
  'UI patterns fire on a Jev label and (text files) a jev* storage key');
  const urls = 'a "https://x.example/p?q" b ws://h:1/ c chrome-extension://id/x.html'.match(URL_PATTERN) || [];
  check(urls.length === 3, 'URL pattern finds https, ws and chrome-extension literals');

  // Phase 68 D-06: the ui/config token allowlist removes only the exact,
  // word-bounded key, and only in the three allowed files.
  const OPTIONS_REL = 'extension/ui/options.js';
  const CONFIG_REL = 'extension/config/config.js';
  const INIT_REL = 'extension/config/init-config.js';
  const PANEL_REL = 'extension/ui/control_panel.html';
  const stillReported = [
    [OPTIONS_REL, '  // Jev fast mode\n'],
    [OPTIONS_REL, '  fsbJevOther: true,\n'],
    [OPTIONS_REL, 'const jevFastMode = false;\n'],
    [OPTIONS_REL, '  fsbJevFastModeEnabledX: false,\n'],
    [OPTIONS_REL, '  xfsbJevFastModeEnabled: false,\n'],
    [OPTIONS_REL, '  fsbJevFastModeEnabled_2: false,\n'],
    [CONFIG_REL, "    { key: 'fsbJevFastModeEnabledX', type: 'boolean', cls: 'writable', default: false }\n"],
    [CONFIG_REL, "    { key: 'fsbjevfastmodeenabled', type: 'boolean', cls: 'writable', default: false }\n"],
    [INIT_REL, '  // JEV fast mode\n'],
    [PANEL_REL, '<label>Jev fast mode</label>\n'],
    [PANEL_REL, '<input type="checkbox" id="fsbJevFastModeEnabled">\n'],
    ['extension/ui/sidepanel.js', "const key = 'fsbJevFastModeEnabled';\n"]
  ];
  for (const [relPath, text] of stillReported) {
    check(uiTextHits(text, relPath).length > 0, 'ui/config scan still reports ' + JSON.stringify(text.trim()) + ' in ' + relPath);
  }
  const allowedOnly = [
    [OPTIONS_REL, "  fsbJevFastModeEnabled: false,\n  elements.fsbJevFastModeEnabled = document.getElementById('fsbJevFastModeEnabled');\n"
      + '    fsbJevFastModeEnabled: elements.fsbJevFastModeEnabled?.checked ?? false,\n'],
    [CONFIG_REL, "    { key: 'fsbJevFastModeEnabled', type: 'boolean', cls: 'writable', default: false }\n"
      + '      fsbJevFastModeEnabled: false, // Phase 68: autopilot fast mode, off by default\n'],
    [INIT_REL, '  fsbJevFastModeEnabled: false,\n']
  ];
  for (const [relPath, text] of allowedOnly) {
    check(uiTextHits(text, relPath).length === 0, relPath + ' text whose only jev text is the exact token fsbJevFastModeEnabled is not reported');
  }
  const mixed = uiTextHits('  fsbJevFastModeEnabled: false,\n  // Jev decides\n', OPTIONS_REL);
  check(mixed.length === 1 && mixed[0].line === 2 && mixed[0].match === 'Jev',
    'other jev text in an allowed file is still reported, on its own line, next to the allowed token');
}

function treeScan(files) {
  console.log('\n--- extension/ tree scan: no upstream path, no JEV_* credential name (D-01, D-09, D-22) ---');
  const violations = [];
  const skipped = [];
  let binaries = 0;
  let openrouterFiles = 0;
  for (const file of files) {
    const read = readForScan(file);
    if (read.skipped) { skipped.push(rel(file) + ' (' + read.size + ' bytes)'); continue; }
    if (read.binary) binaries += 1;
    if (read.text.indexOf('openrouter.ai') !== -1) openrouterFiles += 1;
    for (const pattern of TREE_PATTERNS) {
      for (const hit of findAll(read.text, pattern)) {
        violations.push({ file: rel(file), line: hit.line, pattern: pattern.name, match: hit.match });
      }
    }
  }
  console.log('  files scanned: ' + files.length + ' (' + binaries + ' binary, read as latin1; ' + skipped.length + ' over 5 MB skipped)');
  if (skipped.length) console.log('  skipped: ' + skipped.join(', '));
  console.log('  openrouter.ai appears in ' + openrouterFiles + ' file(s); it is allowed (existing chat provider)');
  check(files.length > 100, 'scanned more than 100 files under extension/ (' + files.length + ')');
  const relFiles = files.map(rel);
  check(relFiles.includes('extension/background.js') && JEV_REL_PATHS.every((p) => relFiles.includes(p)),
    'the walk covers extension/background.js and all three jev modules');
  report(violations, 'tree');
  check(violations.length === 0, 'no systemone, api.typesafe.ai or JEV_* name anywhere under extension/ (' + violations.length + ' violation(s))');
}

function moduleScan() {
  console.log('\n--- extension/ai/jev-*.js: no storage, no serverUrl, one fixed endpoint (D-01, D-09) ---');
  const present = fs.readdirSync(AI_DIR).filter((name) => /^jev-.*\.js$/.test(name)).sort();
  check(JSON.stringify(present) === JSON.stringify(MODULES.map((m) => m.file).slice().sort()),
    'extension/ai holds exactly jev-client.js, jev-policy.js and jev-state.js (' + present.join(', ') + ')');

  const violations = [];
  const urls = [];
  for (const mod of MODULES) {
    const file = path.join(AI_DIR, mod.file);
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of MODULE_PATTERNS) {
      for (const hit of findAll(text, pattern)) {
        violations.push({ file: rel(file), line: hit.line, pattern: pattern.name, match: hit.match });
      }
    }
    for (const hit of findAll(text, { re: URL_PATTERN })) urls.push({ file: mod.file, line: hit.line, url: hit.match });
  }
  report(violations, 'module');
  check(violations.length === 0, 'jev-*.js contain no chrome.storage, localStorage, serverUrl or importScripts (' + violations.length + ' violation(s))');
  for (const u of urls) console.log('  url: ' + u.file + ':' + u.line + ' ' + u.url);
  check(urls.length === 1, 'jev-*.js contain exactly one URL literal (' + urls.length + ')');
  check(urls.length === 1 && urls[0].file === 'jev-client.js' && urls[0].url === ENDPOINT,
    'that URL is ' + ENDPOINT + ', in jev-client.js');
}

function callerScan(files) {
  console.log('\n--- no caller: FsbJev* names live only in extension/ai/jev-*.js (D-01, D-17) ---');
  const violations = [];
  for (const file of files) {
    const relPath = rel(file);
    if (JEV_REL_PATHS.includes(relPath)) continue;
    const read = readForScan(file);
    if (read.skipped) continue;
    for (const hit of findAll(read.text, CALLER_PATTERN)) {
      violations.push({ file: relPath, line: hit.line, pattern: CALLER_PATTERN.name, match: hit.match });
    }
  }
  report(violations, 'caller');
  check(violations.length === 0, 'no file outside extension/ai/jev-*.js names FsbJevState, FsbJevClient or FsbJevPolicy (' + violations.length + ' violation(s))');

  // background.js names only the three file names, in its three load lines.
  const bgLines = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8').split('\n');
  const jevLines = [];
  bgLines.forEach((line, i) => { if (/jev/i.test(line)) jevLines.push({ index: i, text: line }); });
  const expected = MODULES.map((m) => "importScripts('ai/" + m.file + "');");
  check(JSON.stringify(jevLines.map((l) => l.text)) === JSON.stringify(expected),
    'background.js mentions jev only in the three load lines, in the order state, client, policy');
  const discovery = bgLines.indexOf("importScripts('ai/model-discovery.js');");
  check(discovery >= 0 && jevLines.length === 3 && jevLines.every((l, k) => l.index === discovery + 1 + k),
    'the three loads sit directly after ai/model-discovery.js with no line between them');
}

function uiConfigScan() {
  console.log('\n--- no Jev setting, storage key or UI in extension/ui or extension/config (D-01) ---');
  const files = walkFiles(path.join(EXT_DIR, 'ui'), []).concat(walkFiles(path.join(EXT_DIR, 'config'), []));
  const violations = [];
  const tokenFiles = [];
  let textFiles = 0;
  for (const file of files) {
    const read = readForScan(file);
    if (read.skipped) continue;
    const relPath = rel(file);
    // Text files: any jev substring (catches a jevFastMode-style key too),
    // after the Phase 68 D-06 token allowlist in its three files only.
    // Binaries: the word only, so random compressed bytes cannot trip it.
    const pattern = read.binary ? UI_WORD_PATTERN : UI_TEXT_PATTERN;
    if (!read.binary) textFiles += 1;
    const hits = read.binary ? findAll(read.text, pattern) : uiTextHits(read.text, relPath);
    for (const hit of hits) {
      violations.push({ file: relPath, line: hit.line, pattern: pattern.name, match: hit.match });
    }
    if (UI_CONFIG_JEV_TOKENS.some((token) => read.text.indexOf(token) !== -1)) tokenFiles.push(relPath);
  }
  console.log('  ui/config files scanned: ' + files.length + ' (' + textFiles + ' text)');
  check(files.length > 0, 'extension/ui and extension/config hold files to scan');
  report(violations, 'ui/config');
  check(violations.length === 0, 'nothing under extension/ui or extension/config mentions jev apart from the allowed settings key (' + violations.length + ' violation(s))');
  console.log('  files holding an allowed token: ' + (tokenFiles.join(', ') || 'none'));
  check(tokenFiles.every((relPath) => UI_CONFIG_TOKEN_FILES.includes(relPath)),
    'the files under extension/ui and extension/config that hold fsbJevFastModeEnabled are a subset of config.js, init-config.js and options.js');
}

// ---------------------------------------------------------------------------
// vm inert-load proofs
// ---------------------------------------------------------------------------

/**
 * A bare context: console (recording), TextEncoder, URL and timer spies.
 * No chrome, no fetch, no require, no module, no AbortController.
 */
function bareContext() {
  const timerCalls = [];
  const logCalls = [];
  const spy = (name, sink) => function spyFn() { sink.push(name); return 0; };
  const recordingConsole = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) recordingConsole[level] = spy('console.' + level, logCalls);
  const sandbox = {
    console: recordingConsole,
    TextEncoder: TextEncoder,
    URL: URL,
    setTimeout: spy('setTimeout', timerCalls),
    setInterval: spy('setInterval', timerCalls),
    clearTimeout: spy('clearTimeout', timerCalls),
    clearInterval: spy('clearInterval', timerCalls)
  };
  const context = vm.createContext(sandbox);
  return { context, timerCalls, logCalls };
}

/**
 * The same, plus read traps on every browser, network and storage global.
 * Any read at load is recorded (the trap value itself is undefined).
 */
function trappedContext() {
  const base = bareContext();
  const reads = [];
  for (const name of ['chrome', 'browser', 'fetch', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'sessionStorage',
    'indexedDB', 'caches', 'navigator', 'importScripts', 'require', 'module', 'process', 'AbortController']) {
    Object.defineProperty(base.context, name, { configurable: true, enumerable: true, get() { reads.push(name); return undefined; } });
  }
  return Object.assign(base, { reads });
}

function innerGlobalNames(context) {
  return vm.runInContext('Object.getOwnPropertyNames(globalThis)', context).slice().sort();
}

function load(context, mod) {
  const source = fs.readFileSync(path.join(AI_DIR, mod.file), 'utf8');
  try {
    vm.runInContext(source, context, { filename: 'extension/ai/' + mod.file });
    return null;
  } catch (error) {
    return error;
  }
}

function added(before, after) {
  return after.filter((name) => !before.includes(name)).sort();
}

function removed(before, after) {
  return before.filter((name) => !after.includes(name)).sort();
}

function inertAlone() {
  console.log('\n--- each module alone in a bare vm context: one global, no timer, no log, no throw (D-17) ---');
  for (const mod of MODULES) {
    const { context, timerCalls, logCalls } = bareContext();
    const keysBefore = Object.keys(context);
    const innerBefore = innerGlobalNames(context);
    const error = load(context, mod);
    check(error === null, mod.file + ' evaluates without throwing' + (error ? ' (' + error.message + ')' : ''));
    check(JSON.stringify(added(keysBefore, Object.keys(context))) === JSON.stringify([mod.global])
      && removed(keysBefore, Object.keys(context)).length === 0,
    mod.file + ' adds exactly ' + mod.global + ' to the context keys (added: ' + added(keysBefore, Object.keys(context)).join(', ') + ')');
    check(JSON.stringify(added(innerBefore, innerGlobalNames(context))) === JSON.stringify([mod.global]),
      mod.file + ' adds exactly ' + mod.global + ' to the inner global object');
    check(timerCalls.length === 0, mod.file + ' makes zero timer calls at load (' + timerCalls.join(', ') + ')');
    check(logCalls.length === 0, mod.file + ' logs nothing at load (' + logCalls.join(', ') + ')');
    const exported = context[mod.global];
    check(exported !== null && typeof exported === 'object', mod.global + ' is an object');
  }
}

function inertTrapped() {
  console.log('\n--- each module alone with read traps on browser, network and storage globals (D-17) ---');
  for (const mod of MODULES) {
    const { context, timerCalls, reads } = trappedContext();
    const keysBefore = Object.keys(context);
    const error = load(context, mod);
    check(error === null, mod.file + ' evaluates without throwing under read traps' + (error ? ' (' + error.message + ')' : ''));
    check(JSON.stringify(added(keysBefore, Object.keys(context))) === JSON.stringify([mod.global]),
      mod.file + ' still adds exactly ' + mod.global);
    const loadReads = reads.filter((name) => name !== 'module');
    check(loadReads.length === 0, mod.file + ' reads no chrome, fetch, storage, navigator or require global at load (' + loadReads.join(', ') + ')');
    check(timerCalls.length === 0, mod.file + ' makes zero timer calls at load under read traps');
  }
}

function sharedContext() {
  const ctx = bareContext();
  const keysBefore = Object.keys(ctx.context);
  const innerBefore = innerGlobalNames(ctx.context);
  const errors = MODULES.map((mod) => load(ctx.context, mod));
  return Object.assign(ctx, { keysBefore, innerBefore, errors });
}

function inertTogether() {
  console.log('\n--- all three in load order in one shared context: exactly the three Fsb* globals (D-17) ---');
  const { context, timerCalls, logCalls, keysBefore, innerBefore, errors } = sharedContext();
  check(errors.every((e) => e === null), 'state, client and policy evaluate in order without throwing'
    + (errors.some(Boolean) ? ' (' + errors.filter(Boolean).map((e) => e.message).join('; ') + ')' : ''));
  const keysAdded = added(keysBefore, Object.keys(context));
  check(JSON.stringify(keysAdded) === JSON.stringify(JEV_GLOBALS.slice().sort()),
    'the shared context gains exactly FsbJevClient, FsbJevPolicy and FsbJevState (added: ' + keysAdded.join(', ') + ')');
  check(removed(keysBefore, Object.keys(context)).length === 0, 'no context key is removed or replaced away');
  const innerAdded = added(innerBefore, innerGlobalNames(context));
  check(JSON.stringify(innerAdded) === JSON.stringify(JEV_GLOBALS.slice().sort()),
    'the inner global object gains exactly the three Fsb* names and nothing else (added: ' + innerAdded.join(', ') + ')');
  check(timerCalls.length === 0, 'loading all three makes zero timer calls');
  check(logCalls.length === 0, 'loading all three logs nothing');
  for (const name of ['TextEncoder', 'URL', 'setTimeout', 'setInterval', 'console']) {
    check(vm.runInContext('typeof ' + name, context) !== 'undefined', 'the shared context still has its own ' + name);
  }
  check(context.FsbJevClient.ENDPOINT === ENDPOINT, 'FsbJevClient.ENDPOINT is the fixed ' + ENDPOINT);
}

function isInvalidRequestFallback(result) {
  return result !== null && typeof result === 'object'
    && JSON.stringify(Object.keys(result).sort()) === JSON.stringify(['fallback', 'httpStatus', 'latencyMs', 'ok', 'servedModel'])
    && result.ok === false
    && result.fallback === 'invalid_request'
    && result.servedModel === null
    && result.httpStatus === null;
}

async function decideWithoutFetch() {
  console.log('\n--- in the vm context: a client is created and an invalid request never reaches fetch (D-17) ---');
  const INVALID_REQUESTS = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'decide'],
    ['an empty object', {}],
    ['an array', []],
    ['a request with an unknown key', { v: 1, kinds: ['operation'], goal: 'x', model: 'override' }]
  ];

  const scenarios = [
    { label: 'shared context (state loaded)', build: () => sharedContext() },
    {
      label: 'client alone (no FsbJevState)',
      build: () => {
        const ctx = bareContext();
        const error = load(ctx.context, MODULES[1]);
        return Object.assign(ctx, { errors: [error] });
      }
    }
  ];

  for (const scenario of scenarios) {
    const { context, timerCalls, logCalls, errors } = scenario.build();
    check(errors.every((e) => e === null), scenario.label + ': modules load');
    const fetchCalls = [];
    const fetchSpy = function fetchSpy() { fetchCalls.push(Array.from(arguments)); return Promise.reject(new Error('unexpected fetch')); };

    let created = null;
    let injected = null;
    let createError = null;
    try {
      created = context.FsbJevClient.createJevClient();
      injected = context.FsbJevClient.createJevClient({ fetchImpl: fetchSpy });
    } catch (error) {
      createError = error;
    }
    check(createError === null && created && typeof created.decide === 'function' && typeof created.resetCooldown === 'function'
      && injected && typeof injected.decide === 'function',
    scenario.label + ': createJevClient() returns {decide, resetCooldown} without throwing');
    check(fetchCalls.length === 0 && timerCalls.length === 0, scenario.label + ': creating clients calls no fetch and no timer');

    const deciders = [
      ['createJevClient()', created && created.decide],
      ['createJevClient({fetchImpl: spy})', injected && injected.decide],
      ['the default FsbJevClient.decide', context.FsbJevClient.decide]
    ];
    for (const [deciderLabel, decide] of deciders) {
      for (const [requestLabel, request] of INVALID_REQUESTS) {
        let result = null;
        let rejected = null;
        try {
          result = await decide(request);
        } catch (error) {
          rejected = error;
        }
        check(rejected === null && isInvalidRequestFallback(result),
          scenario.label + ': ' + deciderLabel + ' answers ' + requestLabel + ' with {ok:false, fallback:\'invalid_request\'} (got '
          + (rejected ? 'rejection ' + rejected.message : JSON.stringify(result)) + ')');
      }
    }
    check(fetchCalls.length === 0, scenario.label + ': fetch was never called (' + fetchCalls.length + ')');
    check(timerCalls.length === 0, scenario.label + ': no timer was armed for a local answer (' + timerCalls.join(', ') + ')');
    check(logCalls.length === 0, scenario.label + ': nothing was logged (' + logCalls.join(', ') + ')');
    check(vm.runInContext("typeof fetch === 'undefined' && typeof chrome === 'undefined' && typeof require === 'undefined' && typeof module === 'undefined'", context),
      scenario.label + ': the context still has no fetch, chrome, require or module');
  }
}

async function main() {
  console.log('Phase 67 Plan 11 -- Jev extension boundary (D-01, D-09, D-17, D-22)');
  scannerSelfTest();
  const files = walkFiles(EXT_DIR, []);
  treeScan(files);
  moduleScan();
  callerScan(files);
  uiConfigScan();
  inertAlone();
  inertTrapped();
  inertTogether();
  await decideWithoutFetch();

  console.log('\n--- Summary ---');
  console.log('files scanned: ' + files.length);
  console.log('passed: ' + passed);
  console.log('failed: ' + failed);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('FAIL: unexpected error: ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
