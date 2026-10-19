/**
 * Phase 66 — locale resolver, English fallback, and catalog gate.
 * Run: node tests/extension-ui-locale.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');

const locale = require('../extension/utils/ui-locale.js');
const root = path.join(__dirname, '..');

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

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
}

function runGate(args) {
  return spawnSync(process.execPath, ['scripts/verify-extension-i18n.mjs', ...args], {
    cwd: root,
    encoding: 'utf8'
  });
}

const catalogs = {
  en: { locale_seed_greeting: 'FSB is ready', locale_seed_replay: 'Replay speed $SPEED$', locale_seed_brand: 'FSB' },
  de: { locale_seed_greeting: 'FSB ist bereit', locale_seed_replay: 'Wiedergabegeschwindigkeit $SPEED$', locale_seed_brand: 'FSB' },
  ja: { locale_seed_greeting: 'FSBの準備ができました', locale_seed_replay: '再生速度 $SPEED$' },
  es: { locale_seed_replay: 'Velocidad de repetición $SPEED$' },
  'zh-CN': { locale_seed_greeting: 'FSB 已就绪' }
};

for (const code of Object.keys(catalogs)) locale.setCatalog(code, catalogs[code]);

check(locale.resolveLocale('de') === 'de', 'exact German tag');
check(locale.resolveLocale('de-AT') === 'de', 'German region falls back to de');
check(locale.resolveLocale('es-MX') === 'es', 'es-MX falls back to es');
check(locale.resolveLocale('zh-Hans') === 'zh-CN', 'zh-Hans maps to zh-CN');
check(locale.resolveLocale('zh-SG') === 'zh-CN', 'zh-SG maps to zh-CN');
check(locale.resolveLocale('zh') === 'zh-CN', 'bare zh maps to zh-CN');
check(locale.resolveLocale('zh-Hant') === 'zh-TW', 'zh-Hant maps to zh-TW');
check(locale.resolveLocale('zh-HK') === 'zh-TW', 'zh-HK maps to zh-TW');
check(locale.resolveLocale('zh_TW') === 'zh-TW', 'underscore zh_TW maps to zh-TW');
check(locale.resolveLocale('ja-JP') === 'ja', 'ja-JP falls back to ja');
check(locale.resolveLocale('fr-FR') === 'en', 'unknown tag falls back to English');
check(locale.resolveLocale(null) === 'en', 'missing tag falls back to English');
check(locale.folderFor('zh-CN') === 'zh_CN', 'Simplified Chinese folder is zh_CN');
check(locale.folderFor('zh-TW') === 'zh_TW', 'Traditional Chinese folder is zh_TW');

locale.setOverride(null);
locale.setBrowserTag('de');
check(locale.t('locale_seed_greeting') === 'FSB ist bereit', 'browser German loads the German seed');
locale.setBrowserTag('fr');
check(locale.t('locale_seed_greeting') === 'FSB is ready', 'unknown browser language loads English');

locale.setBrowserTag('en');
locale.setOverride('ja');
check(locale.t('locale_seed_greeting') === 'FSBの準備ができました', 'stored ja overrides an English browser');
locale.setOverride(null);
check(locale.t('locale_seed_greeting') === 'FSB is ready', 'clearing the override returns to the browser language');

locale.setOverride('ja');
check(locale.t('locale_seed_brand') === 'FSB', 'missing Japanese key shows English, not a blank string');
check(locale.t('locale_seed_replay', { SPEED: '2x' }) === '再生速度 2x', 'placeholder substitution follows the override');
locale.setOverride('es');
check(locale.t('locale_seed_greeting') === 'FSB is ready', 'empty Spanish greeting catalog falls back to English');

locale.setCatalog('es', { shell_ready: 'Listo', shell_owned_by: 'En uso por $LABEL$' });
locale.setOverride('es');
check(locale.text('shell_owned_by', 'Owned by Ada', { label: 'Ada' }) === 'En uso por Ada', 'text() applies the active catalog and substitutions');
check(locale.text('missing_shell_key', 'Fallback text') === 'Fallback text', 'text() returns the English fallback when the key is missing');
const exactNode = { setAttribute() {}, removeAttribute() {}, get firstChild() { return null; }, childNodes: [], textContent: '' };
locale.markExact(exactNode, 'Ready');
check(exactNode.textContent === 'Listo', 'markExact translates a known chrome string');
locale.markExact(exactNode, 'User typed this');
check(exactNode.textContent === 'User typed this', 'markExact leaves unknown text unchanged');
locale.setOverride(null);

const source = fs.readFileSync(path.join(root, 'extension/utils/ui-locale.js'), 'utf8');
check(!source.includes('fsb-locale'), 'resolver does not mention the website cookie name');
check(!source.includes('document.cookie'), 'resolver does not read document.cookie');

// Nothing in the service worker translates, so it does not load the module.
// Content scripts do, right before the overlay that uses it.
const background = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');
const wsClient = fs.readFileSync(path.join(root, 'extension/ws/ws-client.js'), 'utf8');
check(!background.includes("importScripts('utils/ui-locale.js')"), 'the service worker does not load ui-locale.js');
const contentScriptOrder = /'utils\/ui-locale\.js',\s*'content\/visual-feedback\.js'/;
check(contentScriptOrder.test(background) && contentScriptOrder.test(wsClient),
  'both content-script lists inject ui-locale.js right before visual-feedback.js');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
check(manifest.default_locale === 'en', 'manifest default_locale is en');
check(manifest.name === '__MSG_ext_name__', 'manifest name is a message token');
check(manifest.description === '__MSG_ext_description__', 'manifest description is a message token');

const englishCatalog = JSON.parse(fs.readFileSync(path.join(root, 'extension/_locales/en/messages.json'), 'utf8'));
for (const [english, key] of Object.entries(locale.exact)) {
  check(englishCatalog[key] && englishCatalog[key].message === english, 'exact chrome key ' + key + ' matches the English catalog');
}

check(
  sha256('mcp/src/types.ts') === '6b5f312a5e9a9f3390c973a7f93ef7552db1c110aeeb116084c1f522e776770a',
  'mcp/src/types.ts is byte-stable'
);
check(
  sha256('extension/ai/tool-definitions.js') === '4fd0beeb8baca5e4c8fb502afd1fc412feaa242c3832e92aabca20b47639ebdd',
  'extension/ai/tool-definitions.js is byte-stable'
);

const live = runGate([]);
check(live.status === 0, 'live seed catalog passes the gate');

const good = runGate(['--root', 'tests/fixtures/extension-i18n/good', '--locales', 'en:en,es:es']);
check(good.status === 0, 'good fixture passes');

for (const name of ['bad-missing', 'bad-empty', 'bad-placeholder', 'bad-undefined-placeholder', 'bad-copy', 'bad-literal']) {
  const result = runGate(['--root', `tests/fixtures/extension-i18n/${name}`, '--locales', 'en:en,es:es']);
  check(result.status === 1, `${name} fixture fails the gate`);
}

const autonyms = ['English', 'Español', 'Deutsch', '日本語', '한국어', '简体中文', '繁體中文'];
check(JSON.stringify(locale.PUBLIC_LOCALES.map((code) => locale.NATIVE_LABELS[code])) === JSON.stringify(autonyms), 'language control uses the seven native autonyms');
locale.setBrowserTag('en');
locale.saveOverride('de');
check(locale.current() === 'de', 'choosing German applies without a browser restart');
locale.saveOverride('');
check(locale.current() === 'en', 'clearing the choice follows the browser language');

require('../extension/utils/copy-exact.js');
const copyMismatches = Object.entries(locale.exact).filter(([english, key]) => {
  return String(key).startsWith('copy_') && (!englishCatalog[key] || englishCatalog[key].message !== english);
});
check(copyMismatches.length === 0, 'copy exact map matches the English catalog');
const panelExact = JSON.parse(fs.readFileSync(path.join(root, 'extension/utils/panel-exact.js'), 'utf8').match(/var extra = (\{.*\});/)[1]);
const panelMismatches = Object.entries(panelExact).filter(([english, key]) => !englishCatalog[key] || englishCatalog[key].message !== english);
check(panelMismatches.length === 0, 'panel exact map matches the English catalog');
check(typeof locale.line === 'function', 'line translates a catalog template');
locale.setCatalog('de', { copy_probe: 'Vertrauen für $NAME$' });
locale.setOverride('de');
locale.registerExact({ 'Trust $NAME$ probe': 'copy_probe' });
check(locale.line('Trust $NAME$ probe', { name: 'Grok' }) === 'Vertrauen für Grok', 'line applies the active locale');
locale.setOverride(null);

// statusUpdate compares the shown status against English transient labels,
// which addStatusMessage() may have translated.
locale.registerExact({ 'Probe starting...': 'probe_transient' });
locale.setCatalog('de', { probe_transient: 'Probe wird gestartet...' });
locale.setOverride('de');
check(locale.isLine('Probe starting...', 'Probe wird gestartet...'), 'isLine matches the active translation of an exact line');
check(locale.isLine('Probe starting...', 'Probe starting...'), 'isLine matches the English source');
check(!locale.isLine('Probe starting...', 'Clicked the Submit button'), 'isLine rejects other text');
check(!locale.isLine('Probe starting...', undefined), 'isLine rejects a missing value');
check(!locale.isLine('Not an exact line', 'Probe wird gestartet...'), 'isLine needs the English line in the exact map');
check(!locale.isLine('constructor', 'function Object() { [native code] }'), 'isLine ignores inherited object keys');
check(locale.line('constructor') === 'constructor' && locale.line('constructor', { name: 'Ada' }) === 'constructor',
  'line ignores inherited object keys');
const protoNode = fakeNode({}, '');
locale.markExact(protoNode, 'toString');
check(protoNode.textContent === 'toString' && protoNode.getAttribute('data-i18n-live') === null,
  'markExact ignores inherited object keys');
locale.setOverride(null);
check(locale.isLine('Probe starting...', 'Probe wird gestartet...'), 'isLine still matches text drawn before the language changed');
for (const file of ['extension/ui/sidepanel.js', 'extension/ui/popup.js']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  check(!source.includes('!skipTexts.includes(prevText)') && source.includes('fsbUiLocale.isLine(english, prevText)'),
    `${file} skips translated transient status lines`);
}

const copyGate = spawnSync(process.execPath, ['scripts/verify-extension-copy.mjs'], { cwd: root, encoding: 'utf8' });
check(copyGate.status === 0, 'in-scope chrome is cataloged');
const badSentence = spawnSync(process.execPath, ['scripts/verify-extension-copy.mjs', '--file', 'tests/fixtures/extension-i18n/bad-sentence/ui.js'], { cwd: root, encoding: 'utf8' });
check(badSentence.status === 1, 'uncataloged chrome fixture fails');
check(String(badSentence.stderr).includes('This sentence is not cataloged.'), 'fixture reports the package-owned sentence');
check(String(badSentence.stderr).includes('ui.js:3: uncataloged chrome: This template sentence is not cataloged.'),
  'fixture reports a sentence inside a template expression on its own line');
check(String(badSentence.stderr).includes('$NAME$ sentence is not cataloged here.'), 'fixture reports a sentence that opens with a placeholder');
check(!String(badSentence.stderr).includes('User typed a secret sentence here.'), 'log sentences stay off the coverage gate');
const badUnwired = spawnSync(process.execPath, ['scripts/verify-extension-copy.mjs', '--file', 'tests/fixtures/extension-i18n/bad-unwired/page.html'], { cwd: root, encoding: 'utf8' });
check(badUnwired.status === 1, 'cataloged but unwired HTML text fails');
check(String(badUnwired.stderr).includes('page.html:1: unwired chrome'), 'fixture reports the unwired button label');
check(!/page\.html:[23]:/.test(String(badUnwired.stderr)), 'keyed and translate="no" text stay off the coverage gate');
// Text in markup that JS builds is never translated in place, and a quote or
// `//` inside a regex literal must not shift the scan.
const badMarkup = spawnSync(process.execPath, ['scripts/verify-extension-copy.mjs', '--file', 'tests/fixtures/extension-i18n/bad-markup/ui.js'], { cwd: root, encoding: 'utf8' });
const markupErrors = String(badMarkup.stderr);
check(badMarkup.status === 1, 'unwired markup fixture fails');
check(markupErrors.includes('ui.js:1: unwired chrome in markup (route through the locale helper): Markup sentence is not wired.'),
  'fixture reports markup text in a quoted string');
check(markupErrors.includes('ui.js:2: unwired chrome in markup (route through the locale helper): Sign Up Now'),
  'fixture reports a short label in template markup');
check(markupErrors.includes('ui.js:3: unwired chrome in markup (route through the locale helper): Close this panel'),
  'fixture reports a labelled attribute in template markup');
check(markupErrors.includes('ui.js:5: uncataloged chrome: This sentence follows a regex literal.'),
  'quotes and a trailing \\/\\/ inside a regex literal do not shift the scan');
check(!/ui\.js:(?:[4679]|10):/.test(markupErrors), 'wired, keyed, translate="no", brand, and logged markup stay off the gate');

// The gate only proves copy goes through a helper. Each English literal handed
// to an exact-map helper must also resolve to a key on its page.
function pageExactMap(files) {
  const sandbox = { module: undefined };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
  return sandbox.fsbUiLocale.exact;
}
const literal = "'((?:[^'\\\\]|\\\\.)*)'";
for (const [file, maps, helpers] of [
  ['extension/ui/options.js', ['extension/utils/panel-exact.js', 'extension/utils/copy-exact.js'], 'fsbUiLine|fsbUiHtml|fsbUiMarkup'],
  ['extension/ui/sidepanel.js', ['extension/utils/copy-exact.js'], 'spLine|fsbUiLocale\\.line']
]) {
  const exactMap = pageExactMap(['extension/utils/ui-locale.js', ...maps]);
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const direct = new RegExp(`\\b(?:${helpers})\\(\\s*${literal}`, 'g');
  const ternary = new RegExp(`\\b(?:${helpers})\\([^'()\\n]*\\?\\s*${literal}\\s*:\\s*${literal}`, 'g');
  const english = [];
  for (const match of source.matchAll(direct)) english.push(match[1]);
  for (const match of source.matchAll(ternary)) english.push(match[1], match[2]);
  const unresolved = english.map((text) => text.replace(/\\'/g, "'")).filter((text) => !Object.prototype.hasOwnProperty.call(exactMap, text));
  check(english.length > 0 && unresolved.length === 0, `${file} copy helpers resolve to catalog keys${unresolved.length ? ': ' + unresolved.join(' | ') : ''}`);
}

// Status, toast, and delegation copy that reaches markExact() or a template
// through a variable. Each literal must still be in its file and resolve on
// that page.
const sidePanelMap = pageExactMap(['extension/utils/ui-locale.js', 'extension/utils/copy-exact.js']);
const controlPanelMap = pageExactMap(['extension/utils/ui-locale.js', 'extension/utils/panel-exact.js', 'extension/utils/copy-exact.js']);
for (const [file, exactMap, texts] of [
  ['extension/ui/sidepanel.js', sidePanelMap, [
    'Stop Automation', 'Stopping Automation…', 'Task complete', 'Automation stopped', 'Replay error',
    'Technical details', 'Step $NUMBER$ complete', 'Replaying...', 'Working...', 'Retrying...', 'Error: $ERROR$',
    'Choose another provider', 'Selected provider', 'The agent',
    'Let $NAME$ control this browser?', '$NAME$ may drive FSB browser tools for this task.',
    '$NAME$ cannot run browser tasks', '$NAME$ cannot start this task',
    '$NAME$ sign-in status could not be verified. Use Test Connection in API Configuration, then try again.',
    '$NAME$ could not pass FSB\'s final delegated-browser start checks. Test Connection may still succeed because it does not start a delegated run. Retry the message or review provider setup.',
    '$NAME$ could not start a delegated browser run because $REASON$ ($CODE$). Test Connection may still succeed because it does not start a delegated run. Retry the message or review provider setup.',
    '$NAME$ could not pause for human control.',
    '$NAME$ reported an error before completing this task. Raw provider output was not retained. Try the same message again.',
    '$NAME$ stopped before the task was complete. Try the same message again.',
    'the provider became unavailable', 'the agent process could not be started', 'the agent process could not be verified',
    'the agent spoke an unexpected protocol', 'the connection to the local agent service was lost',
    'the local agent service shut down', 'an earlier agent process did not shut down',
    'an earlier agent run was not cleaned up', 'the start was cancelled'
  ]],
  ['extension/ui/popup.js', sidePanelMap, ['Error occurred', 'Task completed', 'Task partially completed']],
  ['extension/ui/options.js', controlPanelMap, [
    'Model Required', 'Models Required', 'API Key Required', 'Connection Failed', 'Connection Error', 'Test failed',
    'Provide an API key before saving this provider', 'Load an available model from this provider before saving',
    'Changes discarded', 'Logs cleared', 'Session deleted', 'Vault unlocked', 'Incorrect PIN', 'Credential saved',
    'Credential updated', 'Credential deleted', 'Access granted', 'Request denied', 'Memory deleted', 'Memories exported'
  ]]
]) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const missing = texts.filter((text) => !source.includes("'" + text.replace(/'/g, "\\'") + "'"));
  const unresolved = texts.filter((text) => !Object.prototype.hasOwnProperty.call(exactMap, text));
  check(missing.length === 0 && unresolved.length === 0,
    `${file} status and delegation copy resolves on its page${missing.length ? '; not in source: ' + missing.join(' | ') : ''}${unresolved.length ? '; unresolved: ' + unresolved.join(' | ') : ''}`);
}

// MV3's default CSP blocks inline scripts on extension pages, so a boot call
// placed inline never runs.
const uiDir = path.join(root, 'extension/ui');
for (const file of fs.readdirSync(uiDir).filter((name) => name.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(uiDir, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/.test(match[1]) && match[2].trim());
  check(inline.length === 0, `${file} has no inline script`);
}

check(manifest.web_accessible_resources.some((entry) => entry.resources.includes('_locales/*/messages.json')),
  'content scripts can fetch the locale catalogs');

const optionsSource = fs.readFileSync(path.join(root, 'extension/ui/options.js'), 'utf8');
check(optionsSource.includes("hint.textContent = fsbUiLine('Automation prohibited for this origin. ')\n          + (classified.reason || '');"),
  'the blocked-origin hint keeps its denial reason');

const getMessageCalls = [];
globalThis.chrome = { i18n: { getMessage(key, subs) { getMessageCalls.push(subs); return 'Actions: '; } } };
locale.setBrowserTag('en');
locale.setOverride(null);
check(locale.text('probe_missing_key', 'Actions: 5', { count: 5 }) === 'Actions: 5', 'named substitutions keep their values when the catalog lacks the key');
check(getMessageCalls.length === 0, 'chrome.i18n.getMessage never receives named substitutions');
check(locale.t('probe_missing_key') === 'Actions: ' && getMessageCalls.length === 1, 'plain lookups still fall back to chrome.i18n');
delete globalThis.chrome;

// Every static data-i18n text and data-i18n-attr value must equal its English
// message, or apply() will treat it as page-owned and never translate it.
function norm(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&rarr;/g, '→')
    .replace(/&times;/g, '×')
    .replace(/&amp;/g, '&');
}

function staticMismatches(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const misses = [];
  const open = [];
  const token = /<\/([A-Za-z0-9]+)\s*>|<([A-Za-z0-9]+)((?:\s+[^\s=>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let match;
  while ((match = token.exec(source))) {
    if (match[1]) {
      const name = match[1].toLowerCase();
      for (let n = open.length - 1; n >= 0; n -= 1) {
        if (open[n].name !== name) continue;
        const frame = open.splice(n)[0];
        if (frame.key && norm(frame.text) !== norm(englishCatalog[frame.key] && englishCatalog[frame.key].message)) {
          misses.push(`${frame.key}: "${norm(frame.text)}"`);
        }
        break;
      }
      continue;
    }
    if (match[2]) {
      const name = match[2].toLowerCase();
      // apply() skips keyed nodes with child markup, so they would never translate.
      for (const frame of open) {
        if (frame.key) misses.push(`${frame.key}: contains <${name}> markup`);
      }
      const attrs = {};
      for (const attr of (match[3] || '').matchAll(/([^\s=]+)\s*=\s*"([^"]*)"/g)) attrs[attr[1]] = decodeEntities(attr[2]);
      for (const part of (attrs['data-i18n-attr'] || '').split(',')) {
        const bits = part.split(':');
        if (bits.length !== 2) continue;
        const key = bits[1].trim();
        if (norm(attrs[bits[0].trim()]) !== norm(englishCatalog[key] && englishCatalog[key].message)) {
          misses.push(`${key}: ${bits[0].trim()}="${attrs[bits[0].trim()]}"`);
        }
      }
      if (match[4] === '/' || /^(img|input|br|hr|meta|link|source)$/.test(name)) continue;
      open.push({ name, key: attrs['data-i18n'] || null, text: '' });
      continue;
    }
    const value = decodeEntities(match[5]);
    for (const frame of open) frame.text += value;
  }
  return misses;
}

for (const file of [
  'extension/ui/control_panel.html',
  'extension/ui/sidepanel.html',
  'extension/ui/popup.html',
  'extension/ui/unlock.html',
  'extension/ui/microphone-permission.html',
  'extension/ui/onboarding.html'
]) {
  const misses = staticMismatches(file);
  check(misses.length === 0, `${file} static i18n text matches the English catalog${misses.length ? ' (' + misses.slice(0, 3).join('; ') + ')' : ''}`);
}

function fakeNode(attrs, textContent) {
  return {
    attrs: Object.assign({}, attrs),
    textContent,
    childNodes: [],
    get firstChild() { return null; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; }
  };
}

function fakeSelect() {
  const doc = {
    createElement() {
      return { attrs: {}, setAttribute(name, value) { this.attrs[name] = String(value); } };
    }
  };
  return {
    attrs: {},
    options: [],
    listeners: {},
    value: '',
    ownerDocument: doc,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    appendChild(node) { this.options.push(node); },
    addEventListener(type, fn) { this.listeners[type] = fn; }
  };
}

function fakeDoc(nodes) {
  return {
    querySelectorAll(selector) {
      const name = selector.slice(1, -1);
      return nodes.filter((node) => node.getAttribute(name) != null);
    }
  };
}

// A separate resolver instance with the shipped catalogs, so these checks do
// not disturb the seeded instance above.
const shippedCatalogs = {};
for (const code of locale.PUBLIC_LOCALES) {
  const file = path.join(root, 'extension/_locales', locale.folderFor(code), 'messages.json');
  shippedCatalogs[code] = locale.parseMessages(JSON.parse(fs.readFileSync(file, 'utf8')));
}
function freshLocale(globals) {
  const sandbox = Object.assign({ module: undefined }, globals || {});
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ['extension/utils/ui-locale.js', 'extension/utils/copy-exact.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
  }
  for (const code of Object.keys(shippedCatalogs)) sandbox.fsbUiLocale.setCatalog(code, shippedCatalogs[code]);
  return sandbox;
}

function extractNamedFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('missing function ' + name);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('unbalanced function ' + name);
}

// Provider names survive every catalog, and no template token is left behind.
{
  const shipped = freshLocale().fsbUiLocale;
  const subs = { name: 'Grok Build', reason: 'x', code: 'activation_failed', error: 'Grok Build stopped', number: 3 };
  const templates = Object.keys(shipped.exact).filter((english) => english.includes('$NAME$'));
  const leaks = [];
  for (const code of shipped.PUBLIC_LOCALES) {
    shipped.setOverride(code);
    for (const english of templates) {
      const shown = shipped.line(english, subs);
      if (!shown.includes('Grok Build') || shown.includes('$')) leaks.push(`${code}: ${shown}`);
    }
    const reason = shipped.line('the agent process could not be verified');
    const start = shipped.line('$NAME$ could not start a delegated browser run because $REASON$ ($CODE$). Test Connection may still succeed because it does not start a delegated run. Retry the message or review provider setup.',
      { name: 'Grok Build', reason, code: 'activation_failed' });
    if (!start.includes(reason) || !start.includes('activation_failed')) leaks.push(`${code}: ${start}`);
    if (code !== 'en' && reason === 'the agent process could not be verified') leaks.push(`${code}: untranslated reason`);
  }
  check(templates.length >= 20 && leaks.length === 0,
    `$NAME$ templates keep the provider name and fill every token in all locales${leaks.length ? ': ' + leaks.slice(0, 3).join(' | ') : ''}`);
  for (const code of ['ja', 'ko']) {
    shipped.setOverride(code);
    check(shipped.t('copy_ca4a99be2b').includes('Grok Build'), `${code} Grok Build cleanup copy keeps the provider name`);
  }
}

// The overlay translates the English labels the service worker sends, keeps
// the active-phase ellipsis, and leaves AI and task text alone.
{
  const overlaySource = fs.readFileSync(path.join(root, 'extension/content/visual-feedback.js'), 'utf8');
  const slice = overlaySource.slice(overlaySource.indexOf('function ov('), overlaySource.indexOf('var chromeRoots'));
  const shipped = freshLocale().fsbUiLocale;
  shipped.setOverride('ja');
  const overlay = { fsbUiLocale: shipped };
  overlay.globalThis = overlay;
  vm.createContext(overlay);
  vm.runInContext(slice, overlay);
  const ja = shippedCatalogs.ja;
  check(overlay.overlayLabel('Acting…') === ja.entry_phase_acting + '…', 'overlay pill translates the phase and keeps the ellipsis');
  check(overlay.overlayLabel('Task completed') === ja.copy_71fea45d26, 'overlay detail translates the default completion line');
  check(overlay.overlayLabel('Done') === ja.entry_done_pill && overlay.overlayLabel('Planning…') === ja.entry_planning + '…',
    'overlay reuses the existing Done and Planning keys');
  for (const raw of ['Clicked the Submit button', '3/10 companies', '', '…', 'constructor']) {
    check(overlay.overlayLabel(raw) === raw, `overlay leaves ${JSON.stringify(raw)} as sent`);
  }

  const englishCatalogMessages = JSON.parse(fs.readFileSync(path.join(root, 'extension/_locales/en/messages.json'), 'utf8'));
  const labelMisses = Object.entries(overlay.OVERLAY_LABELS)
    .filter(([english, key]) => !englishCatalogMessages[key] || englishCatalogMessages[key].message !== english);
  check(labelMisses.length === 0, `overlay label keys match the English catalog${labelMisses.length ? ': ' + labelMisses.map(([e]) => e).join(' | ') : ''}`);
  const ovMisses = [];
  for (const match of overlaySource.matchAll(/\bov\('([a-z0-9_]+)',\s*'((?:[^'\\]|\\.)*)'\s*[,)]/g)) {
    const entry = englishCatalogMessages[match[1]];
    if (!entry || entry.message !== match[2].replace(/\\'/g, "'")) ovMisses.push(match[1]);
  }
  check(ovMisses.length === 0, `overlay ov() fallbacks match the English catalog${ovMisses.length ? ': ' + ovMisses.join(', ') : ''}`);

  // Drift guard: every label and default detail overlay-state.js builds is mapped.
  const overlayState = require('../extension/utils/overlay-state.js');
  const built = new Set();
  const phases = ['analyzing', 'planning', 'thinking', 'acting', 'executing', 'recovering', 'writing', 'switching_tab',
    'tab_switch', 'calling', 'trigger-watch', 'watching', 'complete', 'error'];
  const results = [undefined, 'success', 'partial', 'error', 'stopped'];
  for (const phase of phases) {
    for (const result of results) {
      for (const extra of [{}, { lifecycle: 'final' }, { progressPercent: 40 }]) {
        const state = overlayState.buildOverlayState(Object.assign({ phase, result }, extra), null);
        built.add(state.display.detail);
        if (state.progress) built.add(state.progress.label.replace(/…$/, ''));
      }
    }
  }
  for (const session of [{ multiSite: {} }, { sheetsData: null }, { sheetsData: { formattingPhase: true } }, { sheetsData: { formattingComplete: true } }]) {
    const state = overlayState.buildOverlayState({ phase: 'writing' }, session);
    built.add(state.progress.label.replace(/…$/, ''));
  }
  // Fallbacks outside overlay-state.js: the generic detail, the MCP visual
  // session start line and its waiting pill.
  const visualSession = fs.readFileSync(path.join(root, 'extension/utils/mcp-visual-session.js'), 'utf8');
  check(background.includes("|| 'Ready to begin'") && visualSession.includes("label: 'Waiting'"),
    'MCP visual session fallbacks are still the mapped English labels');
  for (const label of ['Working', 'Ready to begin', 'Waiting']) built.add(label);
  const agentLoop = fs.readFileSync(path.join(root, 'extension/ai/agent-loop.js'), 'utf8');
  const markerBlock = agentLoop.match(/_al_STEP_MARKER_LABELS = \{([\s\S]*?)\};/);
  for (const match of (markerBlock ? markerBlock[1] : '').matchAll(/:\s*'([^']+)'/g)) built.add(match[1]);
  for (const match of agentLoop.matchAll(/detail = '([^']+)';/g)) built.add(match[1]);
  const unmapped = [...built].filter((label) => !Object.prototype.hasOwnProperty.call(overlay.OVERLAY_LABELS, label));
  check(markerBlock && built.size > 25 && unmapped.length === 0,
    `overlay maps every English label the service worker builds${unmapped.length ? ': ' + unmapped.join(' | ') : ''}`);
}

// The fixed Stop button keeps a translated tooltip when the delegated run
// hands it back, and its pending label follows the locale.
{
  const panelSource = fs.readFileSync(path.join(root, 'extension/ui/sidepanel.js'), 'utf8');
  const shipped = freshLocale().fsbUiLocale;
  shipped.setOverride('de');
  const stopBtn = fakeNode({ 'data-i18n-attr': 'title:shell_stop', title: 'Stop Automation' }, '');
  const classes = new Set(['hidden']);
  stopBtn.classList = {
    add: (name) => classes.add(name),
    remove: (name) => classes.delete(name),
    contains: (name) => classes.has(name)
  };
  let pending = false;
  const context = {
    fsbUiLocale: shipped,
    stopBtn,
    isRunning: false,
    _chatLockedByOwnerChip: false,
    _delegationUsesFixedStop: () => true,
    _delegationStopControlPending: () => pending,
    _ensureDelegationMount: () => ({})
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const name of ['_restoreLegacyStopControl', '_syncDelegationStopControls']) {
    vm.runInContext(extractNamedFunction(panelSource, name), context);
  }
  context._restoreLegacyStopControl();
  check(stopBtn.getAttribute('title') === shippedCatalogs.de.shell_stop, 'restored Stop tooltip uses the active locale');
  pending = true;
  context._syncDelegationStopControls({});
  check(stopBtn.getAttribute('title') === shippedCatalogs.de.copy_26de247a57
      && stopBtn.getAttribute('aria-label') === shippedCatalogs.de.copy_26de247a57,
    'pending delegated Stop title and label use the active locale');
  context._restoreLegacyStopControl();
  shipped.setOverride('ja');
  shipped.apply(fakeDoc([stopBtn]));
  check(stopBtn.getAttribute('title') === shippedCatalogs.ja.shell_stop && shippedCatalogs.ja.shell_stop === '自動化を停止',
    'a language switch re-translates the restored Stop tooltip');
}

// Side panel status lines: plain lines are keyed, templates are filled, and
// AI text is shown as sent.
{
  const panelSource = fs.readFileSync(path.join(root, 'extension/ui/sidepanel.js'), 'utf8');
  const shipped = freshLocale().fsbUiLocale;
  shipped.setOverride('de');
  const statusNode = fakeNode({}, '');
  const runner = [];
  const context = {
    fsbUiLocale: shipped,
    currentStatusMessage: { querySelector: (selector) => (selector === '.status-text' ? statusNode : null) },
    setAutomationRunnerText: (text) => runner.push(text)
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const name of ['spLine', 'updateStatusMessage']) vm.runInContext(extractNamedFunction(panelSource, name), context);
  context.updateStatusMessage('Replaying...');
  check(statusNode.textContent === shippedCatalogs.de.copy_1f78c9a474, 'status line translates a keyed plain line');
  context.updateStatusMessage('Step $NUMBER$ complete', null, { number: 3 });
  check(statusNode.textContent === shippedCatalogs.de.copy_d6786d701f.replace('$NUMBER$', '3') && runner[1] === statusNode.textContent,
    'status line fills a template in the active locale');
  context.updateStatusMessage('Clicked the Submit button');
  check(statusNode.textContent === 'Clicked the Submit button', 'status line leaves AI text as sent');
}

async function asyncChecks() {
  const requested = [];
  await locale.loadCatalogs((url) => {
    requested.push(url);
    return Promise.resolve({ json: () => ({}) });
  }, ['ko', 'zh-TW']);
  check(JSON.stringify(requested) === JSON.stringify(['_locales/ko/messages.json', '_locales/zh_TW/messages.json']),
    'loadCatalogs fetches only the requested locales');
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = () => { fetched += 1; return Promise.reject(new Error('unexpected fetch')); };
  await locale.ensureCatalog('ko');
  globalThis.fetch = realFetch;
  check(fetched === 0, 'ensureCatalog does not refetch a loaded catalog');

  locale.setCatalog('en', { probe_count: '0 of 8 active', probe_title: 'Agent CLI', probe_label: 'Consent mode for origin', shell_ready: 'Ready', shell_working: 'Working' });
  locale.setCatalog('de', { probe_count: '0 von 8 aktiv', probe_title: 'Agent-CLI', probe_label: 'Einwilligungsmodus für Ursprung', shell_ready: 'Bereit', shell_working: 'Arbeitet' });
  locale.setBrowserTag('en');
  locale.setOverride('de');

  const counter = fakeNode({ 'data-i18n': 'probe_count' }, '3 of 4 active');
  const heading = fakeNode({ 'data-i18n': 'probe_title' }, '\n      Agent CLI\n    ');
  const clonedRow = fakeNode({ 'data-i18n-attr': 'aria-label:probe_label', 'aria-label': 'Consent mode for example.com' }, '');
  const templateRow = fakeNode({ 'data-i18n-attr': 'aria-label:probe_label', 'aria-label': 'Consent mode for origin' }, '');
  locale.apply(fakeDoc([counter, heading, clonedRow, templateRow]));
  check(counter.textContent === '3 of 4 active', 'apply leaves static text that a page script replaced');
  check(heading.textContent === 'Agent-CLI', 'apply translates static text that still shows its catalog message');
  check(clonedRow.getAttribute('aria-label') === 'Consent mode for example.com', 'apply leaves attributes that a page script replaced');
  check(templateRow.getAttribute('aria-label') === 'Einwilligungsmodus für Ursprung', 'apply translates attributes that still show their catalog message');

  const withMarkup = fakeNode({ 'data-i18n': 'probe_title' }, 'Agent CLI');
  withMarkup.children = [{}];
  locale.apply(fakeDoc([withMarkup]));
  check(withMarkup.textContent === 'Agent CLI', 'apply leaves static nodes that hold child markup');

  const status = fakeNode({ 'data-i18n': 'shell_ready' }, 'Ready');
  locale.markExact(status, 'Working');
  check(status.textContent === 'Arbeitet' && status.getAttribute('data-i18n-shown') === 'Arbeitet', 'fill records the shown text');
  status.textContent = 'Owned by Ada';
  locale.apply(fakeDoc([status]));
  check(status.textContent === 'Owned by Ada', 'apply leaves a live node that a page script overwrote');
  check(status.getAttribute('data-i18n-live') === null, 'apply drops the live key of an overwritten node');

  const runner = fakeNode({}, '');
  locale.markExact(runner, 'Working');
  locale.setOverride(null);
  locale.apply(fakeDoc([runner]));
  check(runner.textContent === 'Working', 'apply re-translates a live node it still owns');
  locale.markExact(runner, 'Clicking the submit button');
  check(runner.getAttribute('data-i18n-live') === null && runner.getAttribute('data-i18n-shown') === null,
    'markExact with uncataloged text clears the previous live key');
  locale.apply(fakeDoc([runner]));
  check(runner.textContent === 'Clicking the submit button', 'apply does not bring back a cleared live string');

  const select = fakeSelect();
  locale.mountSelect(select);
  check(select.value === '', 'a new picker follows the browser');
  await locale.saveOverride('de');
  check(select.value === 'de', 'the picker follows a language change made elsewhere');
  await locale.saveOverride(null);
  check(select.value === '', 'the picker follows a return to the browser language');

  let refreshed = 0;
  locale.onChange(function () { refreshed += 1; });
  locale.refresh();
  check(refreshed === 1, 'refresh runs onChange callbacks so pages can sync after boot');

  // Content scripts are re-injected into live tabs. The second run must keep
  // the booted instance and its override.
  locale.setOverride('de');
  new Function(source)();
  check(globalThis.fsbUiLocale === locale, 're-injection keeps the booted instance');
  check(locale.t('shell_working') === 'Arbeitet', 're-injection keeps the active override');
  locale.setOverride(null);

  // Content scripts draw overlay text before boot() finishes, through
  // chrome.i18n in the browser language. boot() must load that catalog too, or
  // the text is never recognised and replaced once the stored override applies.
  const jaOverlay = { probe_overlay: { message: 'FSB が自動化中' } };
  const enOverlay = { probe_overlay: { message: 'FSB Automating' } };
  locale.setCatalog('en', {});
  locale.setCatalog('ja', {});
  locale.setBrowserTag(null);
  const bootRequests = [];
  const fetchBeforeBoot = globalThis.fetch;
  globalThis.chrome = {
    i18n: { getUILanguage: () => 'ja', getMessage: (key) => (jaOverlay[key] ? jaOverlay[key].message : '') },
    storage: { local: { get: (_key, cb) => cb({ fsbUiLocale: 'en' }) }, onChanged: { addListener() {} } },
    runtime: { getURL: (file) => file }
  };
  globalThis.fetch = (url) => {
    bootRequests.push(url);
    return Promise.resolve({ json: () => (url.indexOf('/ja/') !== -1 ? jaOverlay : enOverlay) });
  };
  const drawnBeforeBoot = locale.text('probe_overlay', 'FSB Automating');
  try {
    await locale.boot();
  } finally {
    globalThis.fetch = fetchBeforeBoot;
    delete globalThis.chrome;
  }
  check(drawnBeforeBoot === 'FSB が自動化中', 'text drawn before boot follows the browser language');
  check(bootRequests.indexOf('_locales/ja/messages.json') !== -1 && bootRequests.indexOf('_locales/en/messages.json') !== -1,
    'content-script boot loads the browser catalog next to the override');
  check(locale.isMessage('probe_overlay', drawnBeforeBoot), 'boot recognises browser-language text drawn before it finished');
  check(locale.t('probe_overlay') === 'FSB Automating', 'the stored override applies after boot');
  locale.setOverride(null);
  locale.setBrowserTag(null);

  // Extension pages carry the active language on <html lang>; host pages that
  // run the content scripts are never touched.
  const extensionPage = freshLocale({
    location: { protocol: 'chrome-extension:' },
    document: { documentElement: fakeNode({}, ''), querySelectorAll: () => [] }
  });
  const pageLang = () => extensionPage.document.documentElement.getAttribute('lang');
  extensionPage.fsbUiLocale.setOverride('ja');
  extensionPage.fsbUiLocale.refresh();
  check(pageLang() === 'ja', 'a language change sets <html lang> on extension pages');
  extensionPage.fsbUiLocale.setOverride('zh-TW');
  extensionPage.fsbUiLocale.refresh();
  check(pageLang() === 'zh-TW', '<html lang> uses the public locale code');

  const bootedPage = freshLocale({
    location: { protocol: 'chrome-extension:' },
    document: { documentElement: fakeNode({ lang: 'en' }, ''), querySelectorAll: () => [] },
    chrome: {
      i18n: { getUILanguage: () => 'en-US', getMessage: () => '' },
      storage: { local: { get: (_key, cb) => cb({ fsbUiLocale: 'ko' }) }, onChanged: { addListener() {} } },
      runtime: { getURL: (file) => file }
    },
    fetch: () => Promise.resolve({ json: () => ({}) })
  });
  await bootedPage.fsbUiLocale.boot();
  check(bootedPage.document.documentElement.getAttribute('lang') === 'ko', 'boot() sets <html lang> from the stored language');

  const hostPage = freshLocale({
    location: { protocol: 'https:' },
    document: { documentElement: fakeNode({ lang: 'fr' }, ''), querySelectorAll: () => [] }
  });
  hostPage.fsbUiLocale.setOverride('ja');
  hostPage.fsbUiLocale.refresh();
  check(hostPage.document.documentElement.getAttribute('lang') === 'fr', 'content scripts leave the host page <html lang> alone');
}

asyncChecks().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}, (err) => {
  console.error(err);
  process.exit(1);
});
