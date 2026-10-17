'use strict';

// Phase 68 fast-mode element menu (plan 68-02).
//
// Covers the content-side half of the fast-mode menu:
//   - the separate fast-mode registry in dom-state.js (FSB.jevRefMap) and the
//     vault-fill marks (FSB.vaultFilledElements / FSB.noteVaultFilled);
//   - the guarded vault-fill mark calls in actions.js.
//
// Plain Node script: check() counters, a results line and an exit code.
// Node 20 compatible; binds no port.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const kit = require('./fixtures/jev-content-dom-kit.js');

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS:', label);
  } catch (err) {
    failed++;
    console.error('  FAIL:', label);
    console.error('    ', err && err.message ? err.message : err);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

const repoRoot = path.resolve(__dirname, '..');
const DOM_STATE_PATH = path.join(repoRoot, 'extension', 'content', 'dom-state.js');
const ACTIONS_PATH = path.join(repoRoot, 'extension', 'content', 'actions.js');
const domStateSource = fs.readFileSync(DOM_STATE_PATH, 'utf8');
const actionsSource = fs.readFileSync(ACTIONS_PATH, 'utf8');

const REGISTRY_BEGIN = '  // ---- Phase 68 fast-mode registry (begin) ----';
const REGISTRY_END = '  // ---- Phase 68 fast-mode registry (end) ----';

function sliceBetween(text, startMarker, endMarker, { includeEnd = false } = {}) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `start marker present: ${startMarker.trim()}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `end marker present after start: ${endMarker.trim()}`);
  return text.slice(start, includeEnd ? end + endMarker.length : end);
}

function loadRegistrySlice(cryptoImpl) {
  const slice = sliceBetween(domStateSource, REGISTRY_BEGIN, REGISTRY_END, { includeEnd: true });
  const context = { WeakRef, WeakSet, Map, crypto: cryptoImpl };
  return vm.runInNewContext(
    `${slice}\n({ JevRefRegistry, jevRefMap, vaultFilledElements, noteVaultFilled })`,
    context,
    { filename: 'dom-state.js#fast-mode-registry' }
  );
}

function loadRefMapAndRegistry(cryptoImpl) {
  const slice = sliceBetween(domStateSource, '  class RefMap {', REGISTRY_END, { includeEnd: true });
  const context = { WeakRef, WeakSet, Map, crypto: cryptoImpl };
  return vm.runInNewContext(
    `${slice}\n({ RefMap, refMap, JevRefRegistry, jevRefMap })`,
    context,
    { filename: 'dom-state.js#refmap-and-registry' }
  );
}

// ---------------------------------------------------------------------------
section('fast-mode registry (dom-state.js)');

check('the registry block sits directly after the RefMap singleton', () => {
  const singleton = domStateSource.indexOf('  const refMap = new RefMap();');
  const begin = domStateSource.indexOf(REGISTRY_BEGIN);
  assert.ok(singleton > 0 && begin > singleton, 'registry block follows const refMap');
  const between = domStateSource.slice(singleton + '  const refMap = new RefMap();'.length, begin);
  assert.equal(between.trim(), '', 'nothing between the singleton and the registry block');
});

check('a fresh registry has generation <8 hex>-0 and reset() advances the counter', () => {
  const { JevRefRegistry } = loadRegistrySlice(kit.cryptoStub([0xab, 0x01, 0x9f, 0x30]));
  const registry = new JevRefRegistry();
  assert.match(registry.generation, /^[0-9a-f]{8}-0$/);
  const nonce = registry.generation.split('-')[0];
  registry.reset();
  assert.equal(registry.generation, `${nonce}-1`);
  registry.reset();
  assert.equal(registry.generation, `${nonce}-2`);
});

check('the nonce is computed once per registry instance from crypto.getRandomValues', () => {
  const stub = kit.cryptoStub([0x10, 0x20, 0x30, 0x40]);
  const { JevRefRegistry } = loadRegistrySlice(stub);
  const registry = new JevRefRegistry();
  const before = stub.calls;
  const first = registry.generation;
  registry.reset();
  registry.reset();
  const after = registry.generation;
  assert.equal(first.split('-')[0], after.split('-')[0]);
  assert.ok(stub.calls - before <= 1, 'getRandomValues is called at most once per instance');
  assert.ok(stub.calls >= 1, 'getRandomValues was used');
});

check('two registries (two documents) get different nonces', () => {
  const stub = kit.cryptoStub([0x01, 0x02, 0x03, 0x04]);
  const { JevRefRegistry } = loadRegistrySlice(stub);
  const a = new JevRefRegistry();
  const b = new JevRefRegistry();
  const nonceA = a.generation.split('-')[0];
  const nonceB = b.generation.split('-')[0];
  assert.match(nonceA, /^[0-9a-f]{8}$/);
  assert.match(nonceB, /^[0-9a-f]{8}$/);
  assert.notEqual(nonceA, nonceB);
});

check('register mints j1, j2, ... and restarts at j1 after reset()', () => {
  const { JevRefRegistry } = loadRegistrySlice(kit.cryptoStub());
  const registry = new JevRefRegistry();
  const a = kit.makeElement({ tag: 'button', text: 'A' });
  const b = kit.makeElement({ tag: 'button', text: 'B' });
  assert.equal(registry.register(a, 'button', 'A'), 'j1');
  assert.equal(registry.register(b, 'button', 'B'), 'j2');
  assert.equal(registry.size, 2);
  registry.reset();
  assert.equal(registry.size, 0);
  assert.equal(registry.register(b, 'button', 'B'), 'j1');
});

check('get returns the entry with role and name; e-refs and unknown handles are null', () => {
  const { JevRefRegistry } = loadRegistrySlice(kit.cryptoStub());
  const registry = new JevRefRegistry();
  const el = kit.makeElement({ tag: 'button', text: 'Next' });
  registry.register(el, 'button', 'Next');
  const entry = registry.get('j1');
  assert.ok(entry, 'entry for j1');
  assert.equal(entry.role, 'button');
  assert.equal(entry.name, 'Next');
  assert.equal(entry.element.deref(), el);
  assert.equal(registry.get('e1'), null);
  assert.equal(registry.get('j2'), null);
  assert.equal(registry.get(undefined), null);
});

check('findHandle returns the handle whose WeakRef derefs to the element, else null', () => {
  const { JevRefRegistry } = loadRegistrySlice(kit.cryptoStub());
  const registry = new JevRefRegistry();
  const a = kit.makeElement({ tag: 'a', attrs: { href: '/a' }, text: 'A' });
  const b = kit.makeElement({ tag: 'a', attrs: { href: '/b' }, text: 'B' });
  const stranger = kit.makeElement({ tag: 'a', attrs: { href: '/c' }, text: 'C' });
  registry.register(a, 'link', 'A');
  registry.register(b, 'link', 'B');
  assert.equal(registry.findHandle(b), 'j2');
  assert.equal(registry.findHandle(a), 'j1');
  assert.equal(registry.findHandle(stranger), null);
  assert.equal(registry.findHandle(null), null);
});

check('the fast-mode registry never resets or renumbers FSB.refMap (D-14)', () => {
  const { refMap, jevRefMap } = loadRefMapAndRegistry(kit.cryptoStub());
  const e = [1, 2, 3].map((n) => kit.makeElement({ tag: 'button', text: `B${n}` }));
  refMap.reset();
  e.forEach((el, i) => refMap.register(el, `#b${i + 1}`, 'button', `B${i + 1}`));
  const generationBefore = refMap.generationId;
  jevRefMap.reset();
  const others = [4, 5, 6, 7].map((n) => kit.makeElement({ tag: 'button', text: `B${n}` }));
  others.forEach((el, i) => jevRefMap.register(el, 'button', `B${i + 4}`));
  assert.equal(jevRefMap.size, 4);
  const resolved = refMap.resolve('e2');
  assert.ok(resolved && resolved.element === e[1], 'e2 still points at the same element');
  assert.equal(refMap.generationId, generationBefore, 'refMap generation unchanged');
  assert.equal(refMap.size, 3);
});

check('noteVaultFilled marks objects in the WeakSet and ignores non-objects', () => {
  const { vaultFilledElements, noteVaultFilled } = loadRegistrySlice(kit.cryptoStub());
  const field = kit.makeElement({ tag: 'input', attrs: { type: 'password' } });
  assert.equal(vaultFilledElements.has(field), false);
  noteVaultFilled(field);
  assert.equal(vaultFilledElements.has(field), true);
  for (const bad of [null, undefined, 'j1', 42, true]) {
    assert.doesNotThrow(() => noteVaultFilled(bad));
  }
});

check('dom-state.js exports the registry, the singleton and the vault marks next to FSB.refMap', () => {
  const exportsStart = domStateSource.indexOf('  FSB.refMap = refMap;');
  assert.ok(exportsStart > 0);
  const tail = domStateSource.slice(exportsStart);
  for (const line of [
    'FSB.JevRefRegistry = JevRefRegistry;',
    'FSB.jevRefMap = jevRefMap;',
    'FSB.vaultFilledElements = vaultFilledElements;',
    'FSB.noteVaultFilled = noteVaultFilled;',
  ]) {
    assert.ok(tail.includes(line), `export present: ${line}`);
  }
  assert.equal((domStateSource.match(/class JevRefRegistry/g) || []).length, 1);
});

check('the ElementCache slice markers other suites use are intact', () => {
  const start = domStateSource.indexOf('  class ElementCache {');
  const end = domStateSource.indexOf('  const elementCache =', start);
  assert.ok(start >= 0 && end > start);
});

// ---------------------------------------------------------------------------
section('vault-fill marks (actions.js)');

const GUARDED_MARK = /if \(typeof FSB\.noteVaultFilled === 'function'\) FSB\.noteVaultFilled\((\w+)\);/g;

function guardedCalls(body) {
  return Array.from(body.matchAll(GUARDED_MARK)).map((m) => m[1]);
}

check('fillCredentialFields marks the username and password fields it fills', () => {
  const body = sliceBetween(actionsSource, '  tools.fillCredentialFields = async (params) => {', '  tools.fillPaymentFields = async (params) => {');
  assert.deepEqual(guardedCalls(body), ['usernameField', 'passwordField']);
  const usernameFill = body.indexOf("filled.push('username');");
  const passwordFill = body.indexOf("filled.push('password');");
  const marks = Array.from(body.matchAll(GUARDED_MARK)).map((m) => m.index);
  assert.ok(marks[0] > usernameFill && marks[0] < passwordFill, 'username mark follows the username fill');
  assert.ok(marks[1] > passwordFill, 'password mark follows the password fill');
});

check('fillPaymentFields marks each element fillField fills on both success paths', () => {
  const body = sliceBetween(actionsSource, '  tools.fillPaymentFields = async (params) => {', '  FSB.clickAtCoordinates = clickAtCoordinates;');
  const fillField = sliceBetween(body, '    function fillField(element, value) {', '    // Fill card number');
  assert.deepEqual(guardedCalls(fillField), ['element', 'element']);
  assert.equal(guardedCalls(body).length, 2, 'no other mark in the payment handler');
  const returns = Array.from(fillField.matchAll(/return true;/g)).map((m) => m.index);
  const marks = Array.from(fillField.matchAll(GUARDED_MARK)).map((m) => m.index);
  assert.equal(returns.length, 2);
  assert.ok(marks[0] < returns[0] && marks[1] < returns[1] && marks[1] > returns[0], 'each mark sits right before a success return');
});

check('actions.js holds exactly these four guarded marks and no unguarded call', () => {
  assert.equal(guardedCalls(actionsSource).length, 4);
  assert.equal((actionsSource.match(/FSB\.noteVaultFilled\(/g) || []).length, 4);
});

// ---------------------------------------------------------------------------
console.log(`\njev fast menu: ${passed} PASS / ${failed} FAIL`);
process.exit(failed > 0 ? 1 : 0);
