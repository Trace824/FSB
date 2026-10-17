#!/usr/bin/env node
'use strict';

/**
 * Phase 68 Plan 06 Task 1 -- the service-worker start path of fast mode
 * (D-01, D-03, D-05, D-10, F8, F21; AUTO-01, AUTO-05).
 *
 * extension/background.js gains four top-level helpers and four call sites:
 *
 *   - fsbFastModeSessionField(storedValue, source): the session.fastMode value
 *     for a start or a follow-up. Only a stored boolean true yields a field;
 *     a run_task start (source 'mcp') gets enabled:false and never fast-steps.
 *   - fsbFastPathWithDeadline(promise, ms): resolves the promise's value, or
 *     null on rejection or when the deadline passes first.
 *   - fsbCreateFastPathDeps(): the dependency object the fast-path module
 *     reads from globalThis.fsbFastPathDeps (now, readSwitch, requestMenu,
 *     requestSnapshot, getTabUrl). Creating it calls nothing.
 *   - fsbRecomputeFastModeForFollowUp(existingSession, source): delivers the
 *     previous command's unflushed fast steps first, then reads the switch and
 *     assigns or deletes session.fastMode, so a hand-off is never lost.
 *
 * The helpers are extracted by name and evaluated in a vm context with a stub
 * chrome, a stub storage reader and held timers (nothing fires on its own).
 * The call sites are checked on the source, and createSessionHooks must stay
 * byte-identical to P68_START (68-SYNC-RECHECK.md item h).
 *
 * No network, no ports, no real timers. Node 20-safe.
 *
 * Run: node tests/jev-fast-start-path.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// A promise that never settles must not pass as a clean exit.
process.exitCode = 1;

const ROOT = path.join(__dirname, '..');
const BG_PATH = path.join(ROOT, 'extension', 'background.js');
const STATE_PATH = path.join(ROOT, 'extension', 'ai', 'jev-state.js');
const FAST_PATH_PATH = path.join(ROOT, 'extension', 'ai', 'jev-fast-path.js');
const bgSource = fs.readFileSync(BG_PATH, 'utf8');
const bgLines = bgSource.split('\n');

// 68-SYNC-RECHECK.md item h, copied as a literal (this suite never reads .planning).
const CREATE_SESSION_HOOKS_SHA256 = '10ce1a544f31072f71121b8ee872a4ff6cdd8b07adb1c7a14171b50e4e940780';

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

function json(value) {
  return JSON.stringify(value);
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle(times) {
  for (let i = 0; i < (times || 6); i += 1) await flush();
}

/**
 * 68-SYNC-RECHECK.md item h slicing: from `[async ]function <name>(` through
 * the brace that closes the body, the body brace being the first `{` after the
 * parameter list's matching `)`. Returns null when the name is absent.
 */
function sliceFunction(source, name, opts) {
  const plain = 'function ' + name + '(';
  let start = source.indexOf(plain);
  if (start < 0) return null;
  if (!(opts && opts.exact) && source.slice(start - 6, start) === 'async ') start -= 6;
  let i = source.indexOf('(', source.indexOf(plain));
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

function countOf(text, needle) {
  let n = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return n;
}

/** Held timers: a callback runs only when the test fires it. */
function makeTimers() {
  let nextId = 1;
  const pending = new Map();
  const set = [];
  const cleared = [];
  return {
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, fn);
      set.push({ id, ms });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      pending.delete(id);
    },
    fireAll() {
      const fns = Array.from(pending.values());
      pending.clear();
      fns.forEach((fn) => fn());
    },
    pendingCount() {
      return pending.size;
    },
    set,
    cleared
  };
}

/** A stub chrome that records every call; behaviour comes from handlers. */
function makeChrome(handlers) {
  const h = handlers || {};
  const calls = [];
  const chrome = {
    storage: {
      local: {
        get(keys) {
          calls.push({ api: 'storage.local.get', keys: json(keys) });
          return h.storageGet ? h.storageGet(keys) : Promise.resolve({});
        }
      }
    },
    tabs: {
      sendMessage(tabId, message, options) {
        calls.push({ api: 'tabs.sendMessage', tabId, message: json(message), options: json(options) });
        return h.sendMessage ? h.sendMessage(tabId, message, options) : Promise.resolve(null);
      },
      get(tabId) {
        calls.push({ api: 'tabs.get', tabId });
        return h.tabsGet ? h.tabsGet(tabId) : Promise.resolve({ id: tabId });
      }
    }
  };
  return { chrome, calls };
}

const HELPER_NAMES = [
  'fsbFastModeSessionField',
  'fsbFastPathWithDeadline',
  'fsbCreateFastPathDeps',
  'fsbRecomputeFastModeForFollowUp'
];
const helperSources = HELPER_NAMES.map((name) => sliceFunction(bgSource, name));

/** A vm context holding the four helpers and the given globals. */
function makeContext(globals) {
  const ctx = vm.createContext(Object.assign({ console }, globals || {}));
  for (let k = 0; k < HELPER_NAMES.length; k += 1) {
    if (!helperSources[k]) throw new Error('helper not found in background.js: ' + HELPER_NAMES[k]);
    vm.runInContext(helperSources[k], ctx, { filename: 'background.js#' + HELPER_NAMES[k] });
  }
  return ctx;
}

async function main() {
  // -------------------------------------------------------------------------
  section('the helpers exist in extension/background.js');
  HELPER_NAMES.forEach((name, k) => check(typeof helperSources[k] === 'string' && helperSources[k].length > 0,
    name + ' is a top-level function in background.js'));
  if (helperSources.some((s) => !s)) {
    console.error('\nResults: ' + passed + ' passed, ' + failed + ' failed (helpers missing; nothing else can run)');
    process.exitCode = 1;
    return;
  }
  check(/^async function fsbRecomputeFastModeForFollowUp\(existingSession, source\) \{/m.test(bgSource),
    'fsbRecomputeFastModeForFollowUp(existingSession, source) is async');
  check(HELPER_NAMES.every((name) => countOf(bgSource, 'function ' + name + '(') === 1),
    'each helper is declared exactly once');
  check(helperSources.every((s) => !/jev/i.test(s.replace(/\bfsbJevFastModeEnabled\b/g, '').replace(/\bgetJevMenu\b/g, ''))),
    'no helper source contains jev text outside the allowlisted tokens fsbJevFastModeEnabled and getJevMenu');

  // -------------------------------------------------------------------------
  section('fsbFastModeSessionField (D-01, D-03, D-05)');
  {
    const ctx = makeContext();
    const f = ctx.fsbFastModeSessionField;
    check(json(f(true, undefined)) === json({ enabled: true, stored: true, source: null }),
      '(true, undefined) -> {enabled:true, stored:true, source:null} (side panel and popup starts)');
    check(json(f(true, 'dashboard')) === json({ enabled: true, stored: true, source: 'dashboard' }),
      '(true, "dashboard") -> enabled:true, source "dashboard"');
    check(json(f(true, 'mcp')) === json({ enabled: false, stored: true, source: 'mcp' }),
      '(true, "mcp") -> {enabled:false, stored:true, source:"mcp"} (run_task never fast-steps)');
    const offInputs = [[false, undefined], [false, 'mcp'], [undefined, undefined], [undefined, 'dashboard'],
      ['true', undefined], [1, undefined], [null, undefined], [{}, undefined]];
    check(offInputs.every(([v, s]) => f(v, s) === null),
      'false, undefined, "true", 1, null and an object all give null (the field is absent when off)');
    check(f(true, undefined) !== f(true, undefined), 'every call returns a fresh object');
  }

  // -------------------------------------------------------------------------
  section('fsbFastPathWithDeadline');
  {
    const timers = makeTimers();
    const ctx = makeContext({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    const w = ctx.fsbFastPathWithDeadline;

    let out = 'unset';
    w(Promise.resolve({ ok: 1 }), 1500).then((v) => { out = v; });
    await settle();
    check(out && out.ok === 1, 'a value that arrives first is resolved');
    check(timers.set.length === 1 && timers.set[0].ms === 1500, 'one timer armed with the given deadline');
    check(timers.cleared.indexOf(timers.set[0].id) !== -1 && timers.pendingCount() === 0,
      'the timer is cleared when the promise settles');

    out = 'unset';
    w(Promise.reject(new Error('no receiver')), 1500).then((v) => { out = v; });
    await settle();
    check(out === null, 'a rejection resolves null');
    check(timers.pendingCount() === 0, 'the timer is cleared on rejection too');

    out = 'unset';
    let late;
    const held = new Promise((resolve) => { late = resolve; });
    w(held, 3000).then((v) => { out = v; });
    await settle();
    check(out === 'unset' && timers.pendingCount() === 1, 'a pending promise waits for its deadline');
    timers.fireAll();
    await settle();
    check(out === null, 'the deadline resolves null');
    late({ ok: 2 });
    await settle();
    check(out === null, 'a value arriving after the deadline is ignored');
  }

  // -------------------------------------------------------------------------
  section('fsbCreateFastPathDeps: inert creation, the switch reader');
  {
    const timers = makeTimers();
    let storageAnswer = () => Promise.resolve({ fsbJevFastModeEnabled: true });
    const { chrome, calls } = makeChrome({ storageGet: (keys) => storageAnswer(keys) });
    const ctx = makeContext({ chrome, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    const deps = ctx.fsbCreateFastPathDeps();
    check(calls.length === 0 && timers.set.length === 0, 'creating the deps object makes no chrome call and arms no timer');
    check(json(Object.keys(deps).sort()) === json(['getTabUrl', 'now', 'readSwitch', 'requestMenu', 'requestSnapshot']),
      'the deps object holds exactly now, readSwitch, requestMenu, requestSnapshot and getTabUrl');
    check(Object.keys(deps).every((k) => typeof deps[k] === 'function'), 'every member is a function');
    const before = Date.now();
    const t = deps.now();
    check(typeof t === 'number' && t >= before && t <= Date.now(), 'now() returns the wall clock in ms');

    const cases = [
      [() => Promise.resolve({ fsbJevFastModeEnabled: true }), true, 'a stored boolean true'],
      [() => Promise.resolve({ fsbJevFastModeEnabled: false }), false, 'a stored false'],
      [() => Promise.resolve({}), false, 'an absent key'],
      [() => Promise.resolve({ fsbJevFastModeEnabled: 'true' }), false, 'the string "true"'],
      [() => Promise.resolve({ fsbJevFastModeEnabled: 1 }), false, 'the number 1'],
      [() => Promise.resolve(undefined), false, 'an undefined storage answer'],
      [() => Promise.reject(new Error('storage down')), false, 'a storage rejection'],
      [() => { throw new Error('storage sync throw'); }, false, 'a storage call that throws']
    ];
    for (const [answer, expected, label] of cases) {
      storageAnswer = answer;
      calls.length = 0;
      let out = 'unset';
      deps.readSwitch().then((v) => { out = v; }, () => { out = 'rejected'; });
      await settle();
      check(out === expected, 'readSwitch resolves ' + expected + ' for ' + label);
      check(calls.length === 1 && calls[0].api === 'storage.local.get' && calls[0].keys === json(['fsbJevFastModeEnabled']),
        'readSwitch reads only fsbJevFastModeEnabled (' + label + ')');
    }
    storageAnswer = () => new Promise(() => {});
    let hung = 'unset';
    deps.readSwitch().then((v) => { hung = v; });
    await settle();
    check(hung === 'unset', 'a hanging storage read waits for its deadline');
    timers.fireAll();
    await settle();
    check(hung === false, 'a hanging storage read resolves false at its deadline');
  }

  // -------------------------------------------------------------------------
  section('fsbCreateFastPathDeps: menu, snapshot and tab url (content messages, frame 0)');
  {
    const timers = makeTimers();
    let sendAnswer = () => Promise.resolve({ success: true, signature: 's1' });
    let tabAnswer = () => Promise.resolve({ id: 7, url: 'https://shop.example/cart?x=1' });
    const { chrome, calls } = makeChrome({
      sendMessage: (tabId, message, options) => sendAnswer(tabId, message, options),
      tabsGet: (tabId) => tabAnswer(tabId)
    });
    const ctx = makeContext({ chrome, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    const deps = ctx.fsbCreateFastPathDeps();

    const menuOptions = { cap: 48, recent: [], capture: false };
    let out = 'unset';
    deps.requestMenu(7, menuOptions, 1500).then((v) => { out = v; });
    await settle();
    check(calls.length === 1 && calls[0].api === 'tabs.sendMessage' && calls[0].tabId === 7,
      'requestMenu sends one content message to the tab');
    check(calls[0].message === json({ action: 'getJevMenu', options: menuOptions }),
      'requestMenu sends {action:"getJevMenu", options}');
    check(calls[0].options === json({ frameId: 0 }), 'requestMenu targets frame 0');
    check(out && out.success === true && out.signature === 's1', 'requestMenu resolves the content answer');
    check(timers.set.length === 1 && timers.set[0].ms === 1500 && timers.pendingCount() === 0,
      'requestMenu arms the given deadline and clears it on success');

    sendAnswer = () => Promise.reject(new Error('Could not establish connection'));
    out = 'unset';
    deps.requestMenu(7, menuOptions, 1500).then((v) => { out = v; });
    await settle();
    check(out === null, 'requestMenu resolves null when the content script is absent (rejection)');

    sendAnswer = () => { throw new Error('tabs api gone'); };
    out = 'unset';
    deps.requestMenu(7, menuOptions, 1500).then((v) => { out = v; }, () => { out = 'rejected'; });
    await settle();
    check(out === null, 'requestMenu resolves null when sendMessage throws');

    sendAnswer = () => new Promise(() => {});
    out = 'unset';
    deps.requestMenu(7, menuOptions, 1500).then((v) => { out = v; });
    await settle();
    check(out === 'unset', 'a silent content script keeps requestMenu pending until its deadline');
    timers.fireAll();
    await settle();
    check(out === null, 'requestMenu resolves null after the deadline');

    calls.length = 0;
    timers.set.length = 0;
    sendAnswer = () => Promise.resolve({ success: true, markdownSnapshot: 'SNAP', elementCount: 3 });
    out = 'unset';
    deps.requestSnapshot(9, 3000).then((v) => { out = v; });
    await settle();
    check(calls.length === 1 && calls[0].tabId === 9
      && calls[0].message === json({ action: 'getMarkdownSnapshot', options: { charBudget: 12000, maxElements: 80 } })
      && calls[0].options === json({ frameId: 0 }),
    'requestSnapshot sends {action:"getMarkdownSnapshot", options:{charBudget:12000, maxElements:80}} to frame 0');
    check(out && out.success === true && out.markdownSnapshot === 'SNAP', 'requestSnapshot resolves the content answer');
    check(timers.set.length === 1 && timers.set[0].ms === 3000 && timers.pendingCount() === 0,
      'requestSnapshot arms the given deadline and clears it on success');
    sendAnswer = () => Promise.reject(new Error('gone'));
    out = 'unset';
    deps.requestSnapshot(9, 3000).then((v) => { out = v; });
    await settle();
    check(out === null, 'requestSnapshot resolves null on rejection');
    sendAnswer = () => new Promise(() => {});
    out = 'unset';
    deps.requestSnapshot(9, 3000).then((v) => { out = v; });
    await settle();
    timers.fireAll();
    await settle();
    check(out === null, 'requestSnapshot resolves null after the deadline');

    calls.length = 0;
    out = 'unset';
    deps.getTabUrl(7).then((v) => { out = v; });
    await settle();
    check(out === 'https://shop.example/cart?x=1' && calls.length === 1 && calls[0].api === 'tabs.get' && calls[0].tabId === 7,
      'getTabUrl resolves the tab url through chrome.tabs.get');
    tabAnswer = () => Promise.resolve({ id: 7 });
    out = 'unset';
    deps.getTabUrl(7).then((v) => { out = v; });
    await settle();
    check(out === null, 'getTabUrl resolves null for a tab without a url');
    tabAnswer = () => Promise.reject(new Error('No tab with id'));
    out = 'unset';
    deps.getTabUrl(7).then((v) => { out = v; }, () => { out = 'rejected'; });
    await settle();
    check(out === null, 'getTabUrl resolves null when the tab is gone');
  }

  // -------------------------------------------------------------------------
  section('fsbRecomputeFastModeForFollowUp: flush first, then read, then assign or delete (D-10, F8)');
  {
    function makeRecomputeContext(opts) {
      const order = [];
      const reads = [];
      const flushCalls = [];
      const globals = {
        getStorageWithTimeout(keys, timeout, defaults) {
          order.push('read');
          reads.push(json([keys, timeout, defaults]));
          return Promise.resolve({ fsbJevFastModeEnabled: opts.stored });
        }
      };
      if (opts.fastPath !== 'absent') {
        globals.FsbFastPath = {
          flushHandoff(session) {
            order.push('flush');
            flushCalls.push(session);
            if (opts.fastPath === 'throws') throw new Error('flush threw');
            if (opts.fastPath === 'rejects') return Promise.reject(new Error('flush rejected'));
            return Promise.resolve(true);
          }
        };
      }
      return { ctx: makeContext(globals), order, reads, flushCalls };
    }

    {
      const r = makeRecomputeContext({ stored: true });
      const session = { status: 'idle', tabId: 3 };
      let resolved = false;
      await r.ctx.fsbRecomputeFastModeForFollowUp(session, undefined).then(() => { resolved = true; });
      check(resolved, 'the helper resolves');
      check(r.reads.length === 1 && r.reads[0] === json([['fsbJevFastModeEnabled'], 3000, { fsbJevFastModeEnabled: false }]),
        'exactly one storage read of ["fsbJevFastModeEnabled"] with a 3000 ms timeout and a false default');
      check(r.flushCalls.length === 0, 'a session that never had fast mode makes no flushHandoff call');
      check(json(session.fastMode) === json({ enabled: true, stored: true, source: null }),
        'stored true sets fastMode to the session-field value');
    }
    {
      const r = makeRecomputeContext({ stored: true });
      const session = { status: 'idle' };
      await r.ctx.fsbRecomputeFastModeForFollowUp(session, 'mcp');
      check(json(session.fastMode) === json({ enabled: false, stored: true, source: 'mcp' }),
        'a run_task follow-up gets enabled:false');
    }
    for (const stored of [false, undefined, 'true']) {
      const r = makeRecomputeContext({ stored });
      const session = { status: 'idle', fastMode: { enabled: true, stored: true, source: null } };
      await r.ctx.fsbRecomputeFastModeForFollowUp(session, undefined);
      check(!Object.prototype.hasOwnProperty.call(session, 'fastMode'),
        'stored ' + json(stored) + ' deletes fastMode (the field is absent, not false)');
    }
    {
      const r = makeRecomputeContext({ stored: false });
      const session = {
        status: 'idle',
        fastMode: { enabled: true, stored: true, source: null },
        _fastPath: { pendingSteps: [{ op: 'click', role: 'button', label: 'Next', effect: 'progress' }] }
      };
      await r.ctx.fsbRecomputeFastModeForFollowUp(session, undefined);
      check(r.flushCalls.length === 1 && r.flushCalls[0] === session, 'a session with _fastPath gets one flushHandoff call with that session');
      check(json(r.order) === json(['flush', 'read']), 'flushHandoff runs before the storage read');
      check(!Object.prototype.hasOwnProperty.call(session, 'fastMode'), 'fastMode is deleted only afterwards');
    }
    for (const mode of ['rejects', 'throws', 'absent']) {
      const r = makeRecomputeContext({ stored: true, fastPath: mode });
      const session = { status: 'idle', _fastPath: { pendingSteps: [{ op: 'click', role: 'button', label: 'Next', effect: 'progress' }] } };
      let outcome = 'unset';
      await r.ctx.fsbRecomputeFastModeForFollowUp(session, 'dashboard').then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
      check(outcome === 'resolved' && json(session.fastMode) === json({ enabled: true, stored: true, source: 'dashboard' }),
        'a flushHandoff that ' + (mode === 'absent' ? 'is missing (no FsbFastPath)' : mode) + ' still recomputes the field and resolves');
    }
  }

  // -------------------------------------------------------------------------
  section('a switch-off follow-up still delivers the previous command\'s fast step (D-10, end to end)');
  {
    const snapshotCalls = [];
    const fakeDeps = {
      now: () => 1000,
      readSwitch: () => Promise.resolve(false),
      requestMenu: () => Promise.resolve(null),
      requestSnapshot(tabId, deadlineMs) {
        snapshotCalls.push({ tabId, deadlineMs });
        return Promise.resolve({ success: true, markdownSnapshot: 'SNAP' });
      },
      getTabUrl: () => Promise.resolve(null)
    };
    const ctx = makeContext({
      getStorageWithTimeout: () => Promise.resolve({ fsbJevFastModeEnabled: false }),
      fsbFastPathDeps: fakeDeps
    });
    vm.runInContext(fs.readFileSync(STATE_PATH, 'utf8'), ctx, { filename: 'jev-state.js' });
    vm.runInContext(fs.readFileSync(FAST_PATH_PATH, 'utf8'), ctx, { filename: 'jev-fast-path.js' });
    check(ctx.FsbFastPath && typeof ctx.FsbFastPath.flushHandoff === 'function', 'the real fast-path module is loaded in the context');

    const session = {
      status: 'idle',
      tabId: 11,
      commandCount: 1,
      task: 'Finish the wizard',
      messages: [{ role: 'user', content: 'Finish the wizard' }],
      fastMode: { enabled: true, stored: true, source: null },
      _fastPath: {
        off: false,
        offReason: null,
        offCommand: null,
        inFlight: null,
        pendingSteps: [{ op: 'click', role: 'button', label: 'Next', effect: 'progress' }],
        stopReason: null,
        uncertain: false,
        recent: [],
        lastLlmTools: [],
        refEpoch: 0,
        docEpoch: 0
      }
    };
    await ctx.fsbRecomputeFastModeForFollowUp(session, undefined);
    const added = session.messages.slice(1);
    check(added.length === 1 && added[0].role === 'user', 'exactly one role:"user" message is pushed');
    check(added.length === 1 && typeof added[0].content === 'string' && added[0].content.indexOf('FAST MODE HAND-OFF') === 0,
      'it starts with "FAST MODE HAND-OFF"');
    check(added.length === 1 && added[0].content.indexOf('SNAP') !== -1, 'it carries the fresh snapshot');
    check(added.length === 1 && /Next/.test(added[0].content), 'it names the step that ran');
    check(snapshotCalls.length === 1 && snapshotCalls[0].tabId === 11, 'one snapshot request for the session tab');
    check(Array.isArray(session._fastPath.pendingSteps) && session._fastPath.pendingSteps.length === 0, 'pendingSteps is empty afterwards');
    check(!Object.prototype.hasOwnProperty.call(session, 'fastMode'), 'fastMode is deleted (the switch is off)');

    await ctx.fsbRecomputeFastModeForFollowUp(session, undefined);
    check(session.messages.length === 2, 'a second follow-up pushes nothing');
    check(snapshotCalls.length === 1, 'a second follow-up makes no snapshot request');
  }

  // -------------------------------------------------------------------------
  section('source: load line, start path, follow-up path, stop path, createSessionHooks');
  {
    const policyIdx = bgLines.indexOf("importScripts('ai/jev-policy.js');");
    check(countOf(bgSource, "importScripts('ai/jev-fast-path.js');") === 1, 'one load line for ai/jev-fast-path.js');
    check(policyIdx >= 0 && bgLines[policyIdx + 1] === "importScripts('ai/jev-fast-path.js');",
      'the fast-path load line is the line right after the jev-policy load line');
    check(countOf(bgSource, 'globalThis.fsbFastPathDeps = fsbCreateFastPathDeps();') === 1,
      'globalThis.fsbFastPathDeps is created once at the top level');

    const start = sliceFunction(bgSource, 'handleStartAutomation');
    check(typeof start === 'string' && start.length > 0, 'handleStartAutomation found');
    const readAt = start.indexOf('const storedSettings = await getStorageWithTimeout(');
    const readCall = readAt >= 0 ? start.slice(readAt, start.indexOf(');', readAt) + 2) : '';
    const readArgs = readCall.split('\n');
    check(readArgs.length >= 3 && /^\s*\[.*'fsbJevFastModeEnabled'.*\],$/.test(readArgs[1]),
      'the start settings read asks for fsbJevFastModeEnabled');
    check(readArgs.length >= 4 && /fsbJevFastModeEnabled: false/.test(readArgs[3]),
      'its defaults object holds fsbJevFastModeEnabled: false');
    const fieldLine = 'const fastModeField = fsbFastModeSessionField(storedSettings.fsbJevFastModeEnabled, source);';
    const fieldAt = start.indexOf(fieldLine);
    const literalAt = start.indexOf('const sessionData = {');
    check(countOf(start, fieldLine) === 1 && fieldAt > readAt && fieldAt < literalAt,
      'fastModeField is computed once, after the settings read and before the sessionData literal');
    const spreadLine = '...(fastModeField ? { fastMode: fastModeField } : {}),';
    const agentSpread = '...(requestAgentId ? { agentId: requestAgentId } : {}),';
    const spreadAt = start.indexOf(spreadLine);
    const agentAt = start.indexOf(agentSpread);
    check(countOf(start, spreadLine) === 1 && spreadAt > literalAt && agentAt > literalAt
      && start.slice(agentAt + agentSpread.length, spreadAt).trim() === '',
    'the sessionData literal spreads fastMode right after the agentId spread');
    const agentReturn = start.indexOf("if (authoritativeProvider.providerKind === 'agent') {");
    check(agentReturn >= 0 && agentReturn < start.indexOf('fsbFastModeSessionField(')
      && agentReturn < start.indexOf('fsbRecomputeFastModeForFollowUp('),
    'the agent-kind early return stays first (D-03)');

    const followAt = start.indexOf("if (existingSession && existingSession.status === 'idle') {");
    const resetAt = start.indexOf("action: 'resetDOMState'", followAt);
    const hooksAt = start.indexOf('const reactivationHooks = createSessionHooks(sessionId);', followAt);
    const recomputeLine = 'await fsbRecomputeFastModeForFollowUp(existingSession, source);';
    const recomputeAt = start.indexOf(recomputeLine);
    check(countOf(bgSource, recomputeLine) === 1, 'exactly one follow-up recompute call in background.js');
    check(followAt >= 0 && resetAt > followAt && recomputeAt > resetAt && recomputeAt < hooksAt,
      'the recompute runs after the resetDOMState message and before createSessionHooks');
    const between = start.slice(recomputeAt + recomputeLine.length, hooksAt);
    check(between.trim() === '', 'it is the statement right before const reactivationHooks');
    const followBranch = start.slice(followAt, hooksAt);
    check(followBranch.indexOf('fsbJevFastModeEnabled') === -1 && followBranch.indexOf('getStorageWithTimeout') === -1,
      'the follow-up branch itself reads no storage (the helper is the only reader)');
    const helper = sliceFunction(bgSource, 'fsbRecomputeFastModeForFollowUp');
    check(countOf(helper, 'getStorageWithTimeout(') === 1 && countOf(helper, 'fsbJevFastModeEnabled') >= 1,
      'the helper makes the one storage read of the switch');
    check(helper.indexOf('flushHandoff(') !== -1 && helper.indexOf('flushHandoff(') < helper.indexOf('getStorageWithTimeout('),
      'the helper flushes before it reads');
    check(!/chrome\.storage\.local\.set|\.set\(/.test(helper), 'the helper writes no storage');

    const stop = sliceFunction(bgSource, 'handleStopAutomation');
    const guard = "if (session._fastPath && typeof globalThis !== 'undefined' && globalThis.FsbFastPath && typeof globalThis.FsbFastPath.abortInFlight === 'function') {";
    const foundAt = stop.indexOf("automationLogger.debug('Found session to stop'");
    const guardAt = stop.indexOf(guard);
    check(countOf(stop, 'abortInFlight(') === 1 + countOf(guard, 'abortInFlight('), 'handleStopAutomation calls abortInFlight once');
    check(guardAt > foundAt && foundAt >= 0
      && stop.slice(stop.indexOf('\n', foundAt), guardAt).trim() === '',
    'the guarded abort sits right after the "Found session to stop" debug line');
    const callAt = stop.indexOf('globalThis.FsbFastPath.abortInFlight(session);');
    check(callAt > guardAt && stop.slice(guardAt, callAt).indexOf('}') === -1,
      'abortInFlight(session) runs only inside the session._fastPath guard');
    check(countOf(bgSource, 'FsbFastPath.abortInFlight(session)') === 1, 'no other abortInFlight call in background.js');

    const hooks = sliceFunction(bgSource, 'createSessionHooks', { exact: true });
    const hash = crypto.createHash('sha256').update(hooks || '', 'utf8').digest('hex');
    check(hash === CREATE_SESSION_HOOKS_SHA256, 'createSessionHooks is byte-identical to P68_START (' + hash.slice(0, 12) + ')');
  }

  console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
