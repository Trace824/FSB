'use strict';

/**
 * Extension UI locale resolver.
 *
 * Public codes match the showcase registry. Chrome catalog folders use
 * zh_CN and zh_TW. chrome.i18n.getMessage follows the browser UI language,
 * so an explicit chrome.storage.local override is applied here.
 *
 * This module does not read cookies. Locale choice comes from chrome.storage.local
 * or the browser UI language.
 */
(function (root) {
  var PUBLIC_LOCALES = ['en', 'es', 'de', 'ja', 'ko', 'zh-CN', 'zh-TW'];
  var SOURCE_LOCALE = 'en';
  var STORAGE_KEY = 'fsbUiLocale';
  var FOLDERS = {
    en: 'en',
    es: 'es',
    de: 'de',
    ja: 'ja',
    ko: 'ko',
    'zh-CN': 'zh_CN',
    'zh-TW': 'zh_TW'
  };
  var ZH_HANS = { 'zh-cn': true, 'zh-sg': true, zh: true, 'zh-hans': true };
  var ZH_HANT = { 'zh-tw': true, 'zh-mo': true, 'zh-hk': true, 'zh-hant': true };

  var catalogs = {};
  var activeOverride = null;
  var browserTag = null;

  function folderFor(publicCode) {
    return Object.prototype.hasOwnProperty.call(FOLDERS, publicCode) ? FOLDERS[publicCode] : null;
  }

  function isPublicLocale(value) {
    return PUBLIC_LOCALES.indexOf(value) !== -1;
  }

  function resolveLocale(tag) {
    if (typeof tag !== 'string') return SOURCE_LOCALE;
    var lower = tag.trim().toLowerCase().replace(/_/g, '-');
    if (!lower) return SOURCE_LOCALE;
    if (lower.indexOf('zh-hans') === 0 || ZH_HANS[lower]) return 'zh-CN';
    if (lower.indexOf('zh-hant') === 0 || ZH_HANT[lower]) return 'zh-TW';
    var i;
    for (i = 0; i < PUBLIC_LOCALES.length; i++) {
      if (PUBLIC_LOCALES[i].toLowerCase() === lower) return PUBLIC_LOCALES[i];
    }
    var primary = lower.split('-')[0];
    for (i = 0; i < PUBLIC_LOCALES.length; i++) {
      if (PUBLIC_LOCALES[i].toLowerCase() === primary) return PUBLIC_LOCALES[i];
    }
    return SOURCE_LOCALE;
  }

  function messageFromCatalog(code, key) {
    var cat = catalogs[code];
    if (!cat || !Object.prototype.hasOwnProperty.call(cat, key)) return null;
    var msg = cat[key];
    if (typeof msg !== 'string' || msg.length === 0) return null;
    return msg;
  }

  function applySubs(message, subs) {
    if (subs == null) return message;
    if (Array.isArray(subs)) {
      return message.replace(/\$(\d+)/g, function (_all, n) {
        var idx = Number(n) - 1;
        return idx >= 0 && idx < subs.length && subs[idx] != null ? String(subs[idx]) : '';
      });
    }
    if (typeof subs !== 'object') return message;
    return message.replace(/\$([A-Za-z0-9_]+)\$/g, function (all, name) {
      if (Object.prototype.hasOwnProperty.call(subs, name) && subs[name] != null) return String(subs[name]);
      var lower = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(subs, lower) && subs[lower] != null) return String(subs[lower]);
      return all;
    });
  }

  function current() {
    return activeOverride || resolveLocale(browserTag);
  }

  function t(key, subs) {
    var locale = current();
    var msg = messageFromCatalog(locale, key);
    if (msg == null && locale !== SOURCE_LOCALE) msg = messageFromCatalog(SOURCE_LOCALE, key);
    if (msg == null && !activeOverride && root.chrome && root.chrome.i18n && typeof root.chrome.i18n.getMessage === 'function') {
      var fromChrome = root.chrome.i18n.getMessage(key, subs);
      if (typeof fromChrome === 'string' && fromChrome.length > 0) return fromChrome;
    }
    if (msg == null) {
      var english = messageFromCatalog(SOURCE_LOCALE, key);
      msg = english == null ? key : english;
    }
    return applySubs(msg, subs);
  }

  function text(key, english) {
    var value = t(key);
    if (typeof value !== 'string' || value.length === 0 || value === key) return english;
    return value;
  }

  function setCatalog(code, messages) {
    if (!isPublicLocale(code)) return;
    catalogs[code] = messages || {};
  }

  function setBrowserTag(tag) {
    browserTag = tag;
  }

  function setOverride(code) {
    if (code == null || code === '') {
      activeOverride = null;
      return;
    }
    activeOverride = isPublicLocale(code) ? code : null;
  }

  function parseMessages(json) {
    var out = {};
    if (!json || typeof json !== 'object') return out;
    Object.keys(json).forEach(function (key) {
      var entry = json[key];
      if (entry && typeof entry.message === 'string') out[key] = entry.message;
    });
    return out;
  }

  function catalogUrl(code) {
    var folder = folderFor(code);
    var path = '_locales/' + folder + '/messages.json';
    if (root.chrome && root.chrome.runtime && typeof root.chrome.runtime.getURL === 'function') {
      return root.chrome.runtime.getURL(path);
    }
    return path;
  }

  function loadCatalogs(fetchImpl) {
    var fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) return Promise.resolve();
    return Promise.all(PUBLIC_LOCALES.map(function (code) {
      return Promise.resolve(fetchFn(catalogUrl(code))).then(function (res) {
        return res && typeof res.json === 'function' ? res.json() : res;
      }).then(function (json) {
        setCatalog(code, parseMessages(json));
      }).catch(function () {
        if (!catalogs[code]) setCatalog(code, {});
      });
    }));
  }

  function readStorageOverride() {
    return new Promise(function (resolve) {
      var chromeApi = root.chrome;
      if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local || typeof chromeApi.storage.local.get !== 'function') {
        resolve(null);
        return;
      }
      chromeApi.storage.local.get(STORAGE_KEY, function (data) {
        var value = data && data[STORAGE_KEY];
        if (!isPublicLocale(value)) value = null;
        setOverride(value);
        resolve(value);
      });
    });
  }

  function boot() {
    if (root.chrome && root.chrome.i18n && typeof root.chrome.i18n.getUILanguage === 'function') {
      browserTag = root.chrome.i18n.getUILanguage();
    }
    return readStorageOverride().then(function () {
      return loadCatalogs();
    });
  }

  function apply(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return;
    var nodes = doc.querySelectorAll('[data-i18n]');
    var i;
    for (i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    }
    var attrs = doc.querySelectorAll('[data-i18n-attr]');
    for (i = 0; i < attrs.length; i++) {
      var spec = attrs[i].getAttribute('data-i18n-attr') || '';
      spec.split(',').forEach(function (part) {
        var bits = part.split(':');
        if (bits.length !== 2) return;
        attrs[i].setAttribute(bits[0].trim(), t(bits[1].trim()));
      });
    }
  }

  var api = {
    PUBLIC_LOCALES: PUBLIC_LOCALES,
    SOURCE_LOCALE: SOURCE_LOCALE,
    STORAGE_KEY: STORAGE_KEY,
    folderFor: folderFor,
    resolveLocale: resolveLocale,
    t: t,
    text: text,
    apply: apply,
    setCatalog: setCatalog,
    setBrowserTag: setBrowserTag,
    setOverride: setOverride,
    current: current,
    boot: boot,
    parseMessages: parseMessages,
    loadCatalogs: loadCatalogs
  };

  root.fsbUiLocale = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
