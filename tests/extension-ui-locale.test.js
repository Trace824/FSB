/**
 * Phase 66 — locale resolver, English fallback, and catalog gate.
 * Run: node tests/extension-ui-locale.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

const background = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');
const identity = background.indexOf("importScripts('utils/install-identity.js')");
const uiLocale = background.indexOf("importScripts('utils/ui-locale.js')");
const config = background.indexOf("importScripts('config/config.js')");
check(identity !== -1 && uiLocale > identity && uiLocale < config, 'ui-locale loads immediately after install-identity');

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

for (const name of ['bad-missing', 'bad-empty', 'bad-placeholder', 'bad-copy', 'bad-literal']) {
  const result = runGate(['--root', `tests/fixtures/extension-i18n/${name}`, '--locales', 'en:en,es:es']);
  check(result.status === 1, `${name} fixture fails the gate`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
