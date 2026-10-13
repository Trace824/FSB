#!/usr/bin/env node
/**
 * Coverage gate for package-owned extension chrome.
 *
 * Fails when an in-scope UI file contains an English sentence that is not an
 * English catalog message and is not producer-owned (user text, model output,
 * page DOM, secrets, or logs) or a provider name.
 *
 * Usage:
 *   node scripts/verify-extension-copy.mjs
 *   node scripts/verify-extension-copy.mjs --file tests/fixtures/extension-i18n/bad-sentence/ui.js
 */
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = [
  'extension/ui/sidepanel.html',
  'extension/ui/sidepanel.js',
  'extension/ui/popup.html',
  'extension/ui/popup.js',
  'extension/ui/options.js',
  'extension/ui/control_panel.html',
  'extension/ui/onboarding.html',
  'extension/ui/onboarding.js',
  'extension/ui/unlock.html',
  'extension/ui/unlock.js',
  'extension/ui/microphone-permission.html',
  'extension/ui/microphone-permission.js',
  'extension/content/visual-feedback.js'
];

const UNTRANSLATED = new Set([
  'CVV / CVC'
]);

const PROVIDERS = new Set([
  'xAI (Grok)',
  'Google Gemini',
  'OpenAI',
  'Anthropic (Claude)',
  'OpenRouter',
  'LM Studio',
  'Claude Code',
  'Grok Build',
  'OpenClaw',
  'Google AI Studio',
  'Claude Routines',
  'Google AI Studio'
]);

function arg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || !process.argv[idx + 1]) return '';
  return process.argv[idx + 1];
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function decodeJs(body, quote) {
  return body
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, ' ')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\`/g, '`')
    .replace(/\\u2019/g, '’')
    .replace(/\\u00d7/gi, '×')
    .replace(/\\u2026/g, '…');
}

function extractJsStrings(source) {
  const found = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch !== "'" && ch !== '"' && ch !== '`') {
      i += 1;
      continue;
    }
    const start = i;
    i += 1;
    let body = '';
    let closed = false;
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') {
        body += c + (source[i + 1] || '');
        i += 2;
        continue;
      }
      if (c === ch) {
        closed = true;
        i += 1;
        break;
      }
      if (ch === '`' && c === '$' && source[i + 1] === '{') {
        const part = decodeJs(body, ch).replace(/\s+/g, ' ').trim();
        if (part) found.push({ text: part, index: start });
        body = '';
        i += 2;
        let depth = 1;
        while (i < source.length && depth > 0) {
          if (source[i] === '{') depth += 1;
          else if (source[i] === '}') depth -= 1;
          i += 1;
        }
        continue;
      }
      body += c;
      i += 1;
    }
    if (!closed) continue;
    const text = decodeJs(body, ch).replace(/\s+/g, ' ').trim();
    if (text) found.push({ text, index: start });
  }
  return found;
}

function extractHtmlStrings(source) {
  const found = [];
  const withoutScripts = source.replace(/<script[\s\S]*?<\/script>/gi, (block) => ' '.repeat(block.length)).replace(/<style[\s\S]*?<\/style>/gi, (block) => ' '.repeat(block.length));
  const attr = /(?:aria-label|placeholder|title|alt)="([^"]+)"/g;
  let match;
  while ((match = attr.exec(withoutScripts))) {
    found.push({ text: decodeEntities(match[1]).replace(/\s+/g, ' ').trim(), index: match.index });
  }
  const i18nDepth = [];
  const token = /<!--[\s\S]*?-->|<\/([A-Za-z0-9]+)>|<([A-Za-z0-9]+)([^>]*)>|([^<]+)/g;
  while ((match = token.exec(withoutScripts))) {
    if (match[0].startsWith('<!--')) continue;
    if (match[1]) {
      const name = match[1].toLowerCase();
      for (let n = i18nDepth.length - 1; n >= 0; n -= 1) {
        if (i18nDepth[n] === name) {
          i18nDepth.splice(n, 1);
          break;
        }
      }
      continue;
    }
    if (match[2]) {
      const name = match[2].toLowerCase();
      const selfClosing = /\/$/.test(match[3] || '') || /^(img|input|br|hr|meta|link)$/.test(name);
      if (!selfClosing && /\bdata-i18n=/.test(match[3] || '')) i18nDepth.push(name);
      continue;
    }
    if (i18nDepth.length > 0) continue;
    const value = decodeEntities(match[4] || '').replace(/\s+/g, ' ').trim();
    if (value) found.push({ text: value, index: match.index });
  }
  return found;
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&middot;/g, '·')
    .replace(/&rarr;/g, '→')
    .replace(/&times;/g, '×')
    .replace(/&nbsp;/g, ' ');
}

function isProse(text) {
  if (!text || text.includes('<') || text.includes('>')) return false;
  if (PROVIDERS.has(text) || UNTRANSLATED.has(text)) return false;
  if (!/^[A-Z]/.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  if (/^https?:\/\//.test(text)) return false;
  if (/^[A-Z0-9_]{6,}$/.test(text)) return false;
  return true;
}

function isLog(source, index) {
  const before = source.slice(Math.max(0, index - 280), index);
  if (/(?:console|logger|automationLogger)\s*\.\s*(?:log|warn|error|debug|info)\s*\([^)]*$/.test(before)) return true;
  if (/addLog\s*\(\s*['"`][^'"`]+['"`]\s*,\s*$/.test(before)) return true;
  if (/showDebugOutput\s*\(\s*$/.test(before)) return true;
  if (/_sendControl\s*\(/.test(before) && /\}\s*,\s*$/.test(before)) return true;
  return false;
}

function loadEnglish() {
  const json = JSON.parse(readFileSync(join(ROOT, 'extension/_locales/en/messages.json'), 'utf8'));
  const messages = new Set();
  for (const entry of Object.values(json)) {
    if (entry && typeof entry.message === 'string') {
      messages.add(entry.message);
      messages.add(entry.message.trim());
    }
  }
  return messages;
}

export function findUncataloged(files, catalog) {
  const misses = [];
  for (const file of files) {
    const raw = readFileSync(join(ROOT, file), 'utf8');
    const source = stripComments(raw);
    const items = file.endsWith('.html') ? extractHtmlStrings(source) : extractJsStrings(source);
    for (const item of items) {
      if (!isProse(item.text)) continue;
      if (isLog(source, item.index)) continue;
      if (catalog.has(item.text)) continue;
      const line = source.slice(0, item.index).split('\n').length;
      misses.push({ file, line, text: item.text });
    }
  }
  return misses;
}

function main() {
  const only = arg('--file');
  const files = only ? [only] : SCOPE;
  const catalog = loadEnglish();
  const misses = findUncataloged(files, catalog);
  if (misses.length === 0) {
    console.log(`extension copy coverage passed (${files.length} file${files.length === 1 ? '' : 's'})`);
    return;
  }
  for (const miss of misses) {
    console.error(`${relative(ROOT, miss.file)}:${miss.line}: uncataloged chrome: ${miss.text}`);
  }
  console.error(`${misses.length} uncataloged package-owned sentence${misses.length === 1 ? '' : 's'}`);
  process.exit(1);
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) main();
