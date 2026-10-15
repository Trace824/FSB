'use strict';

/**
 * Phase 69 Plan 01 (MCP-01-c, CONTEXT D-05 / D-06): MCP description budget.
 *
 * Measures the current mcp/build tools/list against the frozen 8a058bdf
 * baseline (tests/fixtures/mcp-tools-list-8a058bdf.json) and prints:
 *   - canonical bytes of {tools}, description chars, parameter-description
 *     chars and total chars, for the baseline and for the current list
 *     filtered to the 72 baseline names;
 *   - ceil(chars/4) and ceil(bytes/4), labelled "estimate" (the rule in
 *     extension/ai/transcript-store.js; exact per-model counts are V4);
 *   - the Phase 66.1 settings tool on its own line;
 *   - the five longest current descriptions;
 *   - whether PROJECT.md's "tool-list tokens cut by more than half" target is
 *     met on the whole-list estimate. That line is reported, never gated: the
 *     schema scaffolding is frozen by MCP-04.
 *
 * Gates: in plan 69-01 every gate is off (report-only), so the suite is green
 * on the unchanged build (RESEARCH Pitfall 4). Plan 69-02 turns
 * perToolDescriptionCap on with the first description cuts; plan 69-04 turns
 * budgetFloors and fullCoverage on when the cuts are complete. The baseline
 * figures themselves are always checked.
 *
 * Never asserts a total tool count for the current list (D-02) and never
 * reads git history (D-04).
 *
 * Run: npm --prefix mcp run build && node tests/mcp-description-budget.test.js
 */

const path = require('path');
const { pathToFileURL } = require('url');

const GATES = Object.freeze({ perToolDescriptionCap: false, budgetFloors: false, fullCoverage: false });
const PER_TOOL_DESCRIPTION_CAP = 2048;
const CHAR_REDUCTION_FLOOR = 0.5;
const BYTE_REDUCTION_FLOOR = 0.2;
const EXPECT_SCHEMA_BYTE_CAP = 600;
const BASELINE_FIGURES = Object.freeze({ count: 72, descChars: 54024, paramChars: 34217, bytes: 121379 });

// PROJECT.md: "tool-list tokens cut by more than half". Reported only.
const PROJECT_TOKEN_TARGET_REDUCTION = 0.5;
const LONGEST_DESCRIPTIONS_SHOWN = 5;

const HELPER_PATH = path.join(__dirname, 'helpers', 'mcp-in-process.mjs');

let passed = 0;
let failed = 0;

function check(cond, msg) {
  if (cond) { passed++; console.log('  PASS:', msg); }
  else { failed++; console.error('  FAIL:', msg); }
}

// Helper module (tests/helpers/mcp-in-process.mjs), loaded in main().
let h = null;

function reduction(before, after) {
  return before === 0 ? 0 : (before - after) / before;
}

function formatPercent(fraction) {
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatChange(before, after) {
  const change = before === 0 ? 0 : (after - before) / before;
  return `${change > 0 ? '+' : ''}${formatPercent(change)}`;
}

// Figures for one tools/list (or a filtered part of it). Bytes are always
// canonicalBytes({ tools: list }), the same code path for both sides.
function measure(list) {
  const descChars = h.descChars(list);
  const paramChars = h.paramChars(list);
  const totalChars = descChars + paramChars;
  const bytes = h.canonicalBytes({ tools: list });
  return {
    count: list.length,
    descChars,
    paramChars,
    totalChars,
    bytes,
    charTokenEstimate: h.estimateTokens(totalChars),
    byteTokenEstimate: h.estimateTokens(bytes),
  };
}

function settingsLine(settingsTool) {
  if (!settingsTool) return 'settings (Phase 66.1): absent from the current build';
  const own = measure([settingsTool]);
  return `settings (Phase 66.1, reported on its own line, not in the 72): description ${own.descChars} chars; `
    + `parameter-description ${own.paramChars} chars; canonical bytes ${own.bytes}; `
    + `estimate ${own.charTokenEstimate} tokens (chars/4)`;
}

function printReport(baseline, current, settingsTool, allCurrentTools) {
  const rows = [
    ['tools (baseline names)', 'count'],
    ['description chars', 'descChars'],
    ['parameter-description chars', 'paramChars'],
    ['total chars', 'totalChars'],
    ['estimate: tokens, ceil(chars/4)', 'charTokenEstimate'],
    ['canonical bytes of {tools}', 'bytes'],
    ['estimate: tokens, ceil(bytes/4)', 'byteTokenEstimate'],
  ];
  console.log('\n--- budget report (token figures are estimates, not tokenizer counts) ---');
  console.log(`  ${'measure'.padEnd(34)}${'baseline 8a058bdf'.padStart(18)}${'current'.padStart(12)}${'change'.padStart(10)}`);
  for (const [label, key] of rows) {
    console.log(`  ${label.padEnd(34)}${String(baseline[key]).padStart(18)}${String(current[key]).padStart(12)}`
      + `${formatChange(baseline[key], current[key]).padStart(10)}`);
  }
  console.log(`  ${settingsLine(settingsTool)}`);

  const longest = [...allCurrentTools]
    .map((tool) => ({ name: tool.name, chars: typeof tool.description === 'string' ? tool.description.length : 0 }))
    .sort((a, b) => b.chars - a.chars || (a.name < b.name ? -1 : 1))
    .slice(0, LONGEST_DESCRIPTIONS_SHOWN);
  console.log(`  ${LONGEST_DESCRIPTIONS_SHOWN} longest current descriptions:`);
  for (const entry of longest) console.log(`    ${entry.name.padEnd(28)}${String(entry.chars).padStart(6)} chars`);

  const tokenCut = reduction(baseline.byteTokenEstimate, current.byteTokenEstimate);
  const met = tokenCut > PROJECT_TOKEN_TARGET_REDUCTION;
  console.log(`  PROJECT.md target (>50% tool-list token estimate cut): ${met ? 'MET' : 'NOT MET'} (${formatPercent(tokenCut)})`);
}

// One gate line. An off gate only reports; an on gate is a check.
function gate(name, enabled, cond, detail) {
  if (!enabled) {
    console.log(`  gate off (report-only): ${name} -- ${detail}`);
    return;
  }
  check(cond, `${name}: ${detail}`);
}

(async () => {
  h = await import(pathToFileURL(HELPER_PATH).href);
  const fixture = h.readBaselineFixture();
  const baselineTools = fixture.tools;
  const baselineNames = baselineTools.map((tool) => tool.name);
  const allCurrentTools = h.sortByName(await h.listCurrentTools());
  const currentBaselineTools = h.filterToNames(allCurrentTools, baselineNames);
  const settingsTool = allCurrentTools.find((tool) => tool.name === h.SETTINGS_TOOL_NAME) || null;

  console.log('\n--- baseline figures (frozen fixture) ---');
  const baseline = measure(baselineTools);
  for (const key of ['count', 'descChars', 'paramChars', 'bytes']) {
    check(baseline[key] === BASELINE_FIGURES[key],
      `baseline ${key} is ${baseline[key]} (pinned ${BASELINE_FIGURES[key]})`);
  }

  const current = measure(currentBaselineTools);
  console.log(`\n  current build: ${currentBaselineTools.length} of ${baselineNames.length} baseline names present; `
    + `${allCurrentTools.length - currentBaselineTools.length} other live tool(s) reported separately`);
  printReport(baseline, current, settingsTool, allCurrentTools);

  const withExpect = allCurrentTools.filter((tool) => (
    tool.inputSchema && tool.inputSchema.properties
    && Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, 'expect')
  ));
  if (withExpect.length === 0) {
    console.log('  expect: not published yet');
  } else {
    const largest = Math.max(...withExpect.map((tool) => h.canonicalBytes(tool.inputSchema.properties.expect)));
    console.log(`  expect: published on ${withExpect.length} tools; largest schema ${largest} canonical bytes `
      + `(cap ${EXPECT_SCHEMA_BYTE_CAP}, enforced by tests/mcp-tools-list-shape-freeze.test.js)`);
  }

  // --- gates ---
  console.log('\n--- gates (CONTEXT D-06) ---');
  const overCap = allCurrentTools.filter((tool) => (
    typeof tool.description === 'string' && tool.description.length > PER_TOOL_DESCRIPTION_CAP
  ));
  gate('perToolDescriptionCap', GATES.perToolDescriptionCap, overCap.length === 0,
    `${overCap.length} of ${allCurrentTools.length} live tools exceed ${PER_TOOL_DESCRIPTION_CAP} description chars`
      + (overCap.length ? ` (${overCap.map((tool) => `${tool.name} ${tool.description.length}`).join(', ')})` : ''));
  const charCut = reduction(baseline.totalChars, current.totalChars);
  gate('budgetFloors (chars)', GATES.budgetFloors, charCut >= CHAR_REDUCTION_FLOOR,
    `description + parameter-description chars over the 72 baseline names cut by ${formatPercent(charCut)} `
      + `(floor ${formatPercent(CHAR_REDUCTION_FLOOR)})`);
  const byteCut = reduction(baseline.bytes, current.bytes);
  gate('budgetFloors (bytes)', GATES.budgetFloors, byteCut >= BYTE_REDUCTION_FLOOR,
    `canonical tools/list bytes over the 72 baseline names cut by ${formatPercent(byteCut)} `
      + `(floor ${formatPercent(BYTE_REDUCTION_FLOOR)})`);

  // --- coverage (D-08) ---
  // Report-only until plan 69-04: every live tool must publish text from the
  // MCP description module, with no orphan module keys.
  console.log('\n--- coverage (D-08) ---');
  const baselineByName = new Map(baselineTools.map((tool) => [tool.name, tool]));
  const unchanged = currentBaselineTools.filter((tool) => tool.description === baselineByName.get(tool.name).description);
  gate('fullCoverage', GATES.fullCoverage, unchanged.length === 0,
    `${unchanged.length} of ${currentBaselineTools.length} baseline tools still publish their 8a058bdf description`);

  // --- must-keep (D-10) ---
  // Report-only until plan 69-02 adds the MUST_KEEP table here (plan 69-04
  // completes it): each guidance row must survive, by key phrase, in its
  // named tool or parameter description.
  console.log('\n--- must-keep (D-10) ---');
  console.log('  must-keep table: no rows yet (added with the description cuts in plans 69-02 and 69-04)');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('  FAIL: mcp-description-budget threw:', err && err.stack ? err.stack : err);
  process.exit(1);
});
