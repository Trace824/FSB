'use strict';

/**
 * mcp-settings-tool-contract.test.js (Phase 66.1, plan 07)
 *
 * The `settings` tool as an MCP host sees it. A real SDK Client is linked by
 * InMemoryTransport to the BUILT runtime (mcp/build/runtime.js
 * createRuntime({ bridge })) with a fake bridge, so the suite binds no port
 * and runs on Node 20.
 *
 * Part 1, the built-runtime contract:
 * - tool shape: exactly one `settings` tool, its short description, its
 *   host-safe inputSchema and no annotations (SC1, D-03, D-04)
 * - the 72 tools that existed at 8a058bdf are byte-identical, measured with
 *   toolsListDigest against BASELINE_8A058BDF_TOOLS_DIGEST (SC5, D-21, MCP-04)
 * - the MCP prompts (with the tool-reference table) and resources (with
 *   fsb://config) are byte-identical, and reading fsb://config still sends
 *   exactly one mcp:get-config request (D-21, MCP-04)
 * - every runtime (stdio and HTTP sessions) registers settings, and settings
 *   stays out of TOOL_REGISTRY and the queue's readOnlyTools (SC5)
 * - the built mapFSBError renders SETTING_ codes under the Settings label and
 *   passes the extension's sentence and hint through (D-07)
 * - MCP-edge rules: value coercion, rejected value types, local refusals and
 *   the value-safe write preflight (SC2, RESEARCH Pattern 5)
 *
 * console.log/error/warn and process.stderr.write are captured for the whole
 * run and scanned at the end: no submitted SENTINEL value may appear there.
 * check() writes through the original streams, so its own lines are never
 * part of that scan.
 *
 * The suite reads no .planning file and runs no git: the baseline values are
 * literal constants below.
 *
 * Standalone: npm --prefix mcp run build && node tests/mcp-settings-tool-contract.test.js
 * The root test chain builds mcp before this suite runs.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Pinned baselines (D-21). Never change one of these to match a new build: a
// mismatch is a regression to find in the owning file.
// ---------------------------------------------------------------------------

// tools/list minus `settings`, measured from a build whose mcp/src equals
// 8a058bdf (66.1-TOOLS-DIGEST-BASELINE.json; Node 24 and Node 20 agree).
// Phase 69 intentionally shortens the existing descriptions: it replaces this
// assertion with its own baseline and keeps this value for its token
// comparison (RESEARCH Pitfall 13).
const BASELINE_8A058BDF_TOOLS_DIGEST = { count: 72, sha256: '8321cc7234a7e1d817b5a3e818e75e243d76e60d1911d88b410d38147c8c4a05' };

// Prompts and resources, measured on 2026-10-15 from a build of 469907cb,
// whose mcp/src equals 8a058bdf. Phase 69 keeps these constants unchanged.
const BASELINE_8A058BDF_PROMPTS_DIGEST = { count: 6, sha256: 'cc2dbc24a668a8e6b3866388ce188cba93ef4e900499ee158e9032ccdd55d3c8' };
// The prompt tool table ("# FSB Tool Reference (49 tools)"), kept separate so
// a failure names the table.
const BASELINE_8A058BDF_TOOL_REFERENCE_SHA256 = 'dfa3846f76ab304be341b97dffabd4b0259e8a37cf7bfbeecebc8248350bcb95';
const BASELINE_8A058BDF_RESOURCES_DIGEST = { count: 5, sha256: '2a328451612964481d9b9da1c3feca343c1d77cc8ca9a626acc9c6ee8afb01f7' };

// getPrompt arguments for the prompts that take any; the other two take none.
const FIXED_PROMPT_ARGS = {
  'search-and-extract': { site: 'example.com', query: 'q', fields: 'a,b' },
  'fill-form': { url: 'https://example.com/form', formData: 'name: A' },
  'monitor-page': { url: 'https://example.com', watchFor: 'price change' },
  'navigate-and-read': { url: 'https://example.com', extract: 'title' }
};

const CANNED_CONFIG = { success: true, provider: 'xai', model: 'grok-4-1-fast', apiKeyConfigured: true, connected: true };

// The settings tool itself (plan 66.1-03). Pinned on its own so Phase 69 can
// decide separately whether to shorten it.
const SETTINGS_DESCRIPTION =
  'Read or change FSB settings. No args returns all; key returns one with its allowed values; key and value sets it. API keys and endpoints are read-only.';
const SETTINGS_INPUT_SCHEMA_JSON =
  '{"type":"object","properties":{"key":{"type":"string","description":"Setting name"},"value":{"type":"string","description":"New value (string; true/false and numbers accepted)"}},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}';

const SETTING_CODES = [
  'SETTING_REQUEST_INVALID',
  'SETTING_UNKNOWN_KEY',
  'SETTING_PROTECTED_KEY',
  'SETTING_VALUE_INVALID',
  'SETTING_PROVIDER_NOT_READY',
  'SETTING_DELEGATED_WRITE_REFUSED',
  'SETTING_UNSUPPORTED',
  'SETTING_STORAGE_FAILED'
];

// errors.ts SETTING_NEXT_ACTION_FALLBACK: the one Next action for a SETTING_
// result that carries no recovery hint.
const SETTING_FALLBACK_NEXT_ACTION =
  'Call settings with only a key to see its type and allowed values, or with no arguments to list every setting.';
const PANEL_HINT = 'Change this setting in the FSB Control Panel.';

// ---------------------------------------------------------------------------
// Output, checks and the console/stderr capture
// ---------------------------------------------------------------------------

const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;
const ORIGINAL_CONSOLE = { log: console.log, error: console.error, warn: console.warn };

let passed = 0;
let failed = 0;

function out(line) {
  ORIGINAL_STDOUT_WRITE.call(process.stdout, line + '\n');
}

function check(cond, msg) {
  if (cond) {
    passed += 1;
    out('  PASS: ' + msg);
  } else {
    failed += 1;
    ORIGINAL_STDERR_WRITE.call(process.stderr, '  FAIL: ' + msg + '\n');
  }
}

function checkDeep(actual, expected, msg) {
  const ok = util.isDeepStrictEqual(actual, expected);
  check(ok, ok ? msg : msg + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')');
}

function hasOwn(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const captured = [];
let capturing = false;

function captureText(args) {
  try {
    return args.map((arg) => (typeof arg === 'string' ? arg : util.inspect(arg, { depth: 8 }))).join(' ');
  } catch (_e) {
    return '[uninspectable]';
  }
}

function startCapture() {
  if (capturing) return;
  capturing = true;
  for (const method of Object.keys(ORIGINAL_CONSOLE)) {
    const original = ORIGINAL_CONSOLE[method];
    console[method] = function (...args) {
      captured.push(captureText(args));
      return original.apply(console, args);
    };
  }
  process.stderr.write = function (chunk, ...rest) {
    try {
      captured.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    } catch (_e) { /* capture is best-effort */ }
    return ORIGINAL_STDERR_WRITE.call(process.stderr, chunk, ...rest);
  };
}

function stopCapture() {
  if (!capturing) return;
  capturing = false;
  for (const method of Object.keys(ORIGINAL_CONSOLE)) console[method] = ORIGINAL_CONSOLE[method];
  process.stderr.write = ORIGINAL_STDERR_WRITE;
}

function describeError(err) {
  return err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err);
}

async function section(name, fn) {
  out('\n--- ' + name + ' ---');
  try {
    await fn();
  } catch (err) {
    check(false, name + ' threw: ' + describeError(err));
  }
}

// ---------------------------------------------------------------------------
// Built MCP modules (ESM, loaded once)
// ---------------------------------------------------------------------------

let mcp = null;

async function loadMcp() {
  const sdk = (p) => pathToFileURL(path.join(ROOT, 'mcp', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', p)).href;
  const build = (p) => pathToFileURL(path.join(ROOT, 'mcp', 'build', p)).href;
  const [clientModule, transportModule, runtimeModule, errorsModule, queueModule, inventoryModule, identityModule] =
    await Promise.all([
      import(sdk('client/index.js')),
      import(sdk('inMemory.js')),
      import(build('runtime.js')),
      import(build('errors.js')),
      import(build('queue.js')),
      import(build('client-inventory.js')),
      import(pathToFileURL(path.join(ROOT, 'scripts', 'bench', 'lib', 'identity.mjs')).href)
    ]);
  // AgentScope's lazy agent:register reads the client inventory. Answer it
  // from fixed dependencies so no version probe runs on this machine.
  inventoryModule.__configureClientInventoryForTests({
    platforms: { 'claude-code': {}, opencode: {}, codex: {} },
    now: () => 1_800_000_000_000,
    execFile: (_file, _args, _options, callback) => {
      callback(Object.assign(new Error('not installed'), { code: 'ENOENT' }), '', '');
    }
  });
  return {
    Client: clientModule.Client,
    InMemoryTransport: transportModule.InMemoryTransport,
    createRuntime: runtimeModule.createRuntime,
    mapFSBError: errorsModule.mapFSBError,
    TaskQueue: queueModule.TaskQueue,
    resetInventory: () => inventoryModule.__configureClientInventoryForTests(null),
    toolsListDigest: identityModule.toolsListDigest,
    canonicalJson: identityModule.canonicalJson,
    sha256Hex: identityModule.sha256Hex
  };
}

// ---------------------------------------------------------------------------
// Fake bridge and client sessions
// ---------------------------------------------------------------------------

// The extension-side bridge client the dispatcher sees: only agent_delegated
// is mapped to a delegated run (the real detector is proven in
// tests/mcp-settings-route.test.js Part B).
function makeFakeBridgeClient() {
  return {
    _isDelegationScopedInbound(_type, payload) {
      return Boolean(payload && payload.agentId === 'agent_delegated');
    }
  };
}

// Stands in for WebSocketBridge. Every message is recorded as
// { type, payload, opts } (shallow copies, so an own `value` property stays
// visible). agent:register answers with options.agentId. A respond(type,
// payload) override answers first; otherwise a dispatcher forwards the
// message to the real dispatchMcpMessageRoute and wraps the result as
// MCPBridgeClient._handleMessage does.
function makeBridge(options) {
  const settings = options || {};
  const fakeClient = makeFakeBridgeClient();
  const bridge = {
    isConnected: true,
    calls: [],
    agentId: settings.agentId || 'agent_contract',
    async sendAndWait(message, opts) {
      const type = message && message.type;
      const payload = message && message.payload;
      bridge.calls.push({
        type,
        payload: payload && typeof payload === 'object' ? Object.assign({}, payload) : payload,
        opts: opts && typeof opts === 'object' ? Object.assign({}, opts) : opts
      });
      if (type === 'agent:register') return { success: true, agentId: bridge.agentId };
      if (typeof settings.respond === 'function') {
        const answer = await settings.respond(type, payload || {});
        if (answer !== undefined) return answer;
      }
      if (settings.dispatcher) {
        const result = await settings.dispatcher.dispatchMcpMessageRoute({ type, payload, client: fakeClient });
        return Object.assign({ success: true }, result);
      }
      return { success: false, error: 'Unknown MCP message type: ' + type };
    },
    settingsCalls() {
      return bridge.calls.filter((call) => call.type === 'mcp:get-settings' || call.type === 'mcp:set-setting');
    },
    setCalls() {
      return bridge.calls.filter((call) => call.type === 'mcp:set-setting');
    }
  };
  return bridge;
}

async function openSession(bridge) {
  const runtime = mcp.createRuntime({ bridge });
  const [serverSide, clientSide] = mcp.InMemoryTransport.createLinkedPair();
  await runtime.server.connect(serverSide);
  const client = new mcp.Client({ name: 'settings-contract', version: '1.0.0' });
  await client.connect(clientSide);
  return {
    runtime,
    client,
    async close() {
      try { await client.close(); } catch (_e) { /* already closed */ }
      try { await runtime.server.close(); } catch (_e) { /* already closed */ }
    }
  };
}

async function withSession(bridge, fn) {
  const session = await openSession(bridge);
  try {
    return await fn(session.client, session.runtime);
  } finally {
    await session.close();
  }
}

// One settings call. An SDK that throws on rejected arguments is folded into
// the same { isError, text } shape a returned error has.
async function callSettings(client, args) {
  try {
    const result = await client.callTool({ name: 'settings', arguments: args });
    const text = ((result && result.content) || []).map((part) => (part && part.text) || '').join('\n');
    return { isError: result && result.isError === true, text, raw: result };
  } catch (err) {
    return { isError: true, text: String(err && err.message ? err.message : err), raw: null, thrown: true };
  }
}

function errorText(result) {
  return ((result && result.content) || []).map((part) => (part && part.text) || '').join('\n');
}

function lineStarting(text, prefix) {
  return String(text).split('\n').find((line) => line.startsWith(prefix));
}

function countOf(text, needle) {
  return String(text).split(needle).length - 1;
}

function usesUnionOrTypeArray(node) {
  if (Array.isArray(node)) return node.some(usesUnionOrTypeArray);
  if (!node || typeof node !== 'object') return false;
  for (const key of Object.keys(node)) {
    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') return true;
    if (key === 'type' && Array.isArray(node[key])) return true;
    if (usesUnionOrTypeArray(node[key])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Part 1: the built-runtime contract
// ---------------------------------------------------------------------------

async function partContract() {
  await section('settings on the wire: shape, description and schema (SC1, D-03, D-04)', async () => {
    await withSession(makeBridge(), async (client) => {
      const { tools } = await client.listTools();
      const matches = tools.filter((tool) => tool.name === 'settings');
      check(matches.length === 1, 'tools/list has exactly one tool named settings (found by name)');
      const tool = matches[0] || {};
      check(tool.description === SETTINGS_DESCRIPTION, 'the description is the plan-03 sentence');
      check(typeof tool.description === 'string' && tool.description.length <= 200,
        'the description is at most 200 characters (got ' + String(tool.description || '').length + ')');
      check(JSON.stringify(tool.inputSchema) === SETTINGS_INPUT_SCHEMA_JSON,
        'the inputSchema is the pinned host-safe JSON (got ' + JSON.stringify(tool.inputSchema) + ')');

      const schema = tool.inputSchema || {};
      const properties = schema.properties || {};
      checkDeep(Object.keys(properties).sort(), ['key', 'value'], 'the schema has exactly key and value');
      check(!hasOwn(schema, 'required'), 'neither parameter is required');
      check(!usesUnionOrTypeArray(schema), 'the schema has no anyOf/oneOf/allOf and no type array');
      check(properties.key && properties.key.type === 'string' && properties.value && properties.value.type === 'string',
        'both parameters are plain type string');
      check(!JSON.stringify(schema).includes('maxLength'), 'the schema carries no maxLength');
      check(tool.annotations === undefined, 'settings carries no annotations');

      const offenders = tools.filter((candidate) => usesUnionOrTypeArray(candidate.inputSchema)).map((candidate) => candidate.name);
      checkDeep(offenders, [], 'no tool in tools/list uses anyOf or a type array (unchanged from the baseline)');

      const digest = mcp.toolsListDigest(tools.filter((candidate) => candidate.name !== 'settings'));
      checkDeep(digest, BASELINE_8A058BDF_TOOLS_DIGEST,
        'the 72 tools that existed at 8a058bdf are byte-identical (BASELINE_8A058BDF_TOOLS_DIGEST)');
      if (!util.isDeepStrictEqual(digest, BASELINE_8A058BDF_TOOLS_DIGEST)) {
        out('  DIAG: a moved digest means a pre-existing tool changed name, description or inputSchema;');
        out('  DIAG: diff tools/list against a build of 8a058bdf and fix the owning file, never this constant.');
      }
    });
  });

  await section('prompts and resources are byte-identical to 8a058bdf (D-21, MCP-04)', async () => {
    await withSession(makeBridge(), async (client) => {
      const { prompts } = await client.listPrompts();
      const messages = {};
      for (const prompt of prompts) {
        const reply = await client.getPrompt({ name: prompt.name, arguments: FIXED_PROMPT_ARGS[prompt.name] || {} });
        messages[prompt.name] = reply.messages;
      }
      const promptsDigest = { count: prompts.length, sha256: mcp.sha256Hex(mcp.canonicalJson({ prompts, messages })) };
      checkDeep(promptsDigest, BASELINE_8A058BDF_PROMPTS_DIGEST,
        'listPrompts plus every getPrompt reply equals BASELINE_8A058BDF_PROMPTS_DIGEST');

      const table = messages['tool-reference'] && messages['tool-reference'][0] && messages['tool-reference'][0].content
        ? messages['tool-reference'][0].content.text
        : '';
      check(String(table).startsWith('# FSB Tool Reference (49 tools)'), 'the tool-reference prompt is the 49-tool table');
      check(mcp.sha256Hex(String(table)) === BASELINE_8A058BDF_TOOL_REFERENCE_SHA256,
        'the prompt tool table equals BASELINE_8A058BDF_TOOL_REFERENCE_SHA256');

      const { resources } = await client.listResources();
      const { resourceTemplates } = await client.listResourceTemplates();
      const resourcesDigest = { count: resources.length, sha256: mcp.sha256Hex(mcp.canonicalJson({ resources, resourceTemplates })) };
      checkDeep(resourcesDigest, BASELINE_8A058BDF_RESOURCES_DIGEST,
        'listResources plus listResourceTemplates equals BASELINE_8A058BDF_RESOURCES_DIGEST');
      check(resources.some((resource) => resource.uri === 'fsb://config'), 'fsb://config is still listed');
    });

    const configBridge = makeBridge({
      respond: (type) => (type === 'mcp:get-config' ? clone(CANNED_CONFIG) : undefined)
    });
    await withSession(configBridge, async (client) => {
      const reply = await client.readResource({ uri: 'fsb://config' });
      checkDeep(configBridge.calls, [{ type: 'mcp:get-config', payload: {}, opts: { timeout: 10000 } }],
        "reading fsb://config sends exactly one {type:'mcp:get-config', payload:{}} with a 10 s timeout");
      checkDeep(reply && reply.contents,
        [{ uri: 'fsb://config', mimeType: 'application/json', text: JSON.stringify(CANNED_CONFIG, null, 2) }],
        'fsb://config returns the extension payload pretty-printed as application/json');
    });
  });

  await section('every runtime registers settings; it stays off the autopilot surface (SC5)', async () => {
    const first = await openSession(makeBridge());
    const second = await openSession(makeBridge());
    try {
      check(first.runtime.server !== second.runtime.server, 'two createRuntime() calls build two servers');
      const firstTools = (await first.client.listTools()).tools.map((tool) => tool.name);
      const secondTools = (await second.client.listTools()).tools.map((tool) => tool.name);
      check(firstTools.filter((name) => name === 'settings').length === 1, 'the first runtime registers settings');
      check(secondTools.filter((name) => name === 'settings').length === 1, 'the second runtime registers settings');
    } finally {
      await first.close();
      await second.close();
    }

    const indexSource = fs.readFileSync(path.join(ROOT, 'mcp', 'src', 'index.ts'), 'utf8');
    const httpSource = fs.readFileSync(path.join(ROOT, 'mcp', 'src', 'http.ts'), 'utf8');
    const runtimeSource = fs.readFileSync(path.join(ROOT, 'mcp', 'src', 'runtime.ts'), 'utf8');
    check(/createRuntime\(/.test(indexSource), 'mcp/src/index.ts (stdio) builds its session with createRuntime(');
    check(/createRuntime\(/.test(httpSource), 'mcp/src/http.ts (HTTP) builds its sessions with createRuntime(');
    check(countOf(runtimeSource, 'registerSettingsTool(server, bridge, queue, agentScope);') === 1,
      'createRuntime registers settings exactly once');

    const toolDefinitions = require(path.join(ROOT, 'mcp', 'ai', 'tool-definitions.cjs'));
    const registryNames = toolDefinitions.TOOL_REGISTRY.map((tool) => tool.name);
    check(registryNames.length > 0 && !registryNames.includes('settings'), 'TOOL_REGISTRY has no tool named settings');
    const queue = new mcp.TaskQueue();
    check(queue.readOnlyTools instanceof Set && !queue.readOnlyTools.has('settings'),
      "a TaskQueue's readOnlyTools does not contain 'settings'");
  });

  await section('built mapFSBError renders SETTING_ codes under Settings (D-07)', async () => {
    for (const code of SETTING_CODES) {
      const withSentence = mcp.mapFSBError({
        success: false, code, errorCode: code, error: 'The request was refused.', recoveryHint: PANEL_HINT
      });
      const text = errorText(withSentence);
      check(withSentence.isError === true, code + ' is an error result');
      check(text.startsWith('Detected: Settings\n'), code + ' renders Detected: Settings');
      check(lineStarting(text, 'Why: ') === 'Why: ' + code + ': The request was refused.', code + ' appears verbatim in the Why line');
      check(lineStarting(text, 'Next action: ') === 'Next action: ' + PANEL_HINT, code + ' uses the recoveryHint verbatim');
      check(!text.includes('Page navigation'), code + ' never renders Page navigation');
      check(!text.includes('Raw error:'), code + ' adds no Raw error line');

      const bare = mcp.mapFSBError({ success: false, code, errorCode: code });
      const bareText = errorText(bare);
      check(bareText.startsWith('Detected: Settings\n') && lineStarting(bareText, 'Why: ') === 'Why: ' + code,
        code + ' with no sentence renders the code alone');
      check(lineStarting(bareText, 'Next action: ') === 'Next action: ' + SETTING_FALLBACK_NEXT_ACTION,
        code + ' with no recoveryHint uses the single settings fallback');
      check(!bareText.includes('Update the MCP server/extension pair'),
        code + ' with no recoveryHint never says Update the MCP server/extension pair');
      check(!bareText.includes('Page navigation'), code + ' with no sentence never renders Page navigation');
    }

    const blankHint = errorText(mcp.mapFSBError({
      success: false, code: 'SETTING_UNKNOWN_KEY', errorCode: 'SETTING_UNKNOWN_KEY', error: 'Unknown setting key.', recoveryHint: '   '
    }));
    check(lineStarting(blankHint, 'Next action: ') === 'Next action: ' + SETTING_FALLBACK_NEXT_ACTION,
      'a blank recoveryHint falls back to the settings Next action');

    const modelName = errorText(mcp.mapFSBError({
      success: false,
      code: 'SETTING_VALUE_INVALID',
      errorCode: 'SETTING_VALUE_INVALID',
      error: 'modelName must be a known model for xai. Allowed: grok-4-1-fast.'
    }));
    check(modelName.startsWith('Detected: Settings\n') && !modelName.includes('Detected: Configuration'),
      'a SETTING_VALUE_INVALID sentence naming modelName is not configuration_error');

    const notFound = errorText(mcp.mapFSBError({
      success: false, code: 'SETTING_UNKNOWN_KEY', errorCode: 'SETTING_UNKNOWN_KEY', error: 'Setting not found.'
    }));
    check(notFound.startsWith('Detected: Settings\n') && !notFound.includes('Page navigation') && !notFound.includes('Refresh page state'),
      "a SETTING_UNKNOWN_KEY sentence containing 'not found' is not element_not_found");

    const element = mcp.mapFSBError({ success: false, error: 'Element not found' });
    check(element.isError === true
      && errorText(element) === 'Detected: Page navigation\nWhy: Element not found\nNext action: Refresh page state with read_page or get_dom_snapshot, then retry.',
    "{success:false, error:'Element not found'} still renders the element_not_found text");

    const allowedSentence = 'maxIterations must be a whole number from 50 to 500. Allowed: 50 to 500.';
    const allowed = errorText(mcp.mapFSBError({
      success: false, code: 'SETTING_VALUE_INVALID', errorCode: 'SETTING_VALUE_INVALID', error: allowedSentence
    }));
    check(lineStarting(allowed, 'Why: ') === 'Why: SETTING_VALUE_INVALID: ' + allowedSentence,
      'an error ending with an Allowed clause appears unchanged in the Why line');
    check(countOf(allowed, 'Allowed: 50 to 500.') === 1, 'the Allowed clause appears exactly once');

    const fields = errorText(mcp.mapFSBError({
      success: false,
      code: 'SETTING_VALUE_INVALID',
      errorCode: 'SETTING_VALUE_INVALID',
      error: 'maxIterations must be a whole number.',
      values: ['SENTINEL-V'],
      range: { min: 1, max: 2 },
      value: 'SENTINEL-VAL'
    }));
    check(!fields.includes('SENTINEL'), 'values, range and value fields are never rendered (no SENTINEL)');
    check(!fields.includes('Allowed:'), 'MCP never builds an Allowed clause of its own');
    check(!fields.includes('1 to 2'), 'the range field is never formatted into the text');
  });

  await section('values reach the bridge as strings; other types are refused (SC2)', async () => {
    const bridge = makeBridge({
      respond: (type, payload) => {
        if (type === 'mcp:get-settings') {
          return { success: true, key: payload.key, value: 'old', type: 'string', writable: true };
        }
        if (type === 'mcp:set-setting') {
          return { success: true, key: payload.key, value: payload.value, previous: 'old', changed: [payload.key] };
        }
        return undefined;
      }
    });
    await withSession(bridge, async (client) => {
      for (const [input, expected] of [[true, 'true'], [50, '50'], [1.5, '1.5']]) {
        const before = bridge.setCalls().length;
        const result = await callSettings(client, { key: 'fsbContractKey', value: input });
        const sets = bridge.setCalls();
        const last = sets[sets.length - 1];
        check(!result.isError && sets.length === before + 1, 'value ' + JSON.stringify(input) + ' is written');
        check(last && last.payload.value === expected,
          'value ' + JSON.stringify(input) + " arrives in mcp:set-setting as '" + expected + "' (got " + JSON.stringify(last && last.payload.value) + ')');
      }

      for (const [label, input] of [['null', null], ['an object', { a: 'SENTINEL-OBJ' }], ['an array', ['SENTINEL-ARR']]]) {
        const before = bridge.calls.length;
        const result = await callSettings(client, { key: 'fsbContractKey', value: input });
        check(result.isError === true, 'value ' + label + ' is refused with isError');
        check(bridge.calls.length === before, 'value ' + label + ' makes no bridge call');
        check(!result.text.includes('SENTINEL'), 'the refusal for ' + label + ' does not echo the value');
      }
    });
  });

  await section('local refusals never reach the bridge (SC2)', async () => {
    const bridge = makeBridge({
      respond: (type, payload) => (type === 'mcp:get-settings'
        ? { success: true, key: payload.key, value: 1, type: 'integer', writable: true }
        : undefined)
    });
    await withSession(bridge, async (client) => {
      const cases = [
        ['value without key', { value: 'x' }],
        ['a 65-character key (read)', { key: 'k'.repeat(65) }],
        ['a 65-character key (write)', { key: 'k'.repeat(65), value: 'SENTINEL-K65' }],
        ['a 2049-character value', { key: 'maxIterations', value: 'SENTINEL-LONG' + 'x'.repeat(2049 - 'SENTINEL-LONG'.length) }]
      ];
      for (const [label, args] of cases) {
        const before = bridge.calls.length;
        const result = await callSettings(client, args);
        check(result.isError === true && result.text.includes('SETTING_REQUEST_INVALID'), label + ' returns SETTING_REQUEST_INVALID');
        check(bridge.calls.length === before, label + ' makes no bridge call');
        check(!result.text.includes('SENTINEL'), label + ' does not echo the value');
      }
      const valueOnly = await callSettings(client, { value: 'x' });
      check(valueOnly.text.startsWith('Detected: Settings\n'), 'a local refusal renders under the Settings label');

      const before = bridge.settingsCalls().length;
      const boundary = await callSettings(client, { key: 'k'.repeat(64) });
      check(!boundary.isError && bridge.settingsCalls().length === before + 1, 'a 64-character key is allowed through');
    });
  });

  await section('write preflight keeps the value in the MCP process (RESEARCH Pattern 5, T-66.1-05)', async () => {
    const unsupportedBridge = makeBridge({
      respond: (type) => ({ success: false, error: 'Unknown MCP message type: ' + type })
    });
    await withSession(unsupportedBridge, async (client) => {
      const result = await callSettings(client, { key: 'debugMode', value: 'SENTINEL-UNSUP' });
      check(result.isError === true && result.text.includes('SETTING_UNSUPPORTED'),
        'an extension without settings routes gets SETTING_UNSUPPORTED');
      check(unsupportedBridge.setCalls().length === 0, 'no mcp:set-setting is sent to an extension without settings routes');
      check(!JSON.stringify(unsupportedBridge.calls).includes('SENTINEL'), 'the value never reaches an old extension');
      check(!result.text.includes('SENTINEL'), 'SETTING_UNSUPPORTED does not echo the value');
    });

    const readOnlyBridge = makeBridge({
      respond: (type, payload) => {
        if (type === 'mcp:get-settings') return { success: true, key: payload.key, value: '[set]', type: 'secret', writable: false };
        if (type === 'mcp:set-setting') {
          return {
            success: false,
            code: 'SETTING_PROTECTED_KEY',
            errorCode: 'SETTING_PROTECTED_KEY',
            error: payload.key + ' is read-only over MCP; change it in the FSB Control Panel.',
            recoveryHint: PANEL_HINT
          };
        }
        return undefined;
      }
    });
    await withSession(readOnlyBridge, async (client) => {
      const result = await callSettings(client, { key: 'apiKey', value: 'sk-SENTINEL-PRE' });
      const sets = readOnlyBridge.setCalls();
      check(sets.length === 1 && !hasOwn(sets[0].payload, 'value'),
        'a key the extension reports as writable:false is written without a value property');
      check(result.isError === true && result.text.includes('SETTING_PROTECTED_KEY'), 'the extension refusal reaches the host');
      check(!JSON.stringify(readOnlyBridge.calls).includes('SENTINEL') && !result.text.includes('SENTINEL'),
        'the protected value never leaves the MCP process');
    });

    const unknownFailure = {
      success: false,
      code: 'SETTING_UNKNOWN_KEY',
      errorCode: 'SETTING_UNKNOWN_KEY',
      error: 'Unknown setting key. Call settings with no arguments to list keys.'
    };
    const unknownBridge = makeBridge({
      respond: (type) => (type === 'mcp:get-settings' || type === 'mcp:set-setting' ? clone(unknownFailure) : undefined)
    });
    await withSession(unknownBridge, async (client) => {
      const result = await callSettings(client, { key: 'noSuchSetting', value: 'SENTINEL-UNKNOWN' });
      const sets = unknownBridge.setCalls();
      check(sets.length === 1 && !hasOwn(sets[0].payload, 'value'),
        'an unknown key (SETTING_UNKNOWN_KEY preflight) is written without a value property');
      check(result.isError === true && result.text.includes('SETTING_UNKNOWN_KEY'), 'SETTING_UNKNOWN_KEY reaches the host');
      check(!JSON.stringify(unknownBridge.calls).includes('SENTINEL') && !result.text.includes('SENTINEL'),
        'the value for an unknown key never leaves the MCP process');
    });

    const capBridge = makeBridge({
      respond: (type) => (type === 'mcp:get-settings'
        ? { success: false, code: 'AGENT_CAP_REACHED', errorCode: 'AGENT_CAP_REACHED', error: 'Agent cap reached.' }
        : undefined)
    });
    await withSession(capBridge, async (client) => {
      const result = await callSettings(client, { key: 'debugMode', value: 'SENTINEL-CAP' });
      check(result.isError === true, 'a failed preflight (AGENT_CAP_REACHED) is an error');
      check(capBridge.setCalls().length === 0, 'a failed preflight sends no mcp:set-setting');
      check(!result.text.includes('SENTINEL'), 'a failed preflight does not echo the value');
    });
  });

  await section('success output is one compact line in the D-07 shapes', async () => {
    const bridge = makeBridge({
      respond: (type, payload) => {
        if (type === 'mcp:get-settings' && payload.key === undefined) {
          return { success: true, settings: { debugMode: false, maxIterations: 100 }, readOnly: ['apiKey'], extra: 'dropped' };
        }
        if (type === 'mcp:get-settings') {
          return { success: true, key: payload.key, value: 100, type: 'integer', writable: true, range: { min: 50, max: 500 }, extra: 'dropped' };
        }
        if (type === 'mcp:set-setting') {
          return { success: true, key: payload.key, value: 200, previous: 100, changed: [payload.key], extra: 'dropped' };
        }
        return undefined;
      }
    });
    await withSession(bridge, async (client) => {
      const shapes = [
        ['read-all', {}, ['readOnly', 'settings']],
        ['read-one', { key: 'maxIterations' }, ['key', 'range', 'type', 'value', 'writable']],
        ['write', { key: 'maxIterations', value: '200' }, ['changed', 'key', 'previous', 'value']]
      ];
      for (const [mode, args, keys] of shapes) {
        const result = await callSettings(client, args);
        check(!result.isError, mode + ' succeeds');
        check(!result.text.includes('\n'), mode + ' output is one line');
        let parsed = null;
        try { parsed = JSON.parse(result.text); } catch (_e) { parsed = null; }
        checkDeep(parsed && Object.keys(parsed).sort(), keys, mode + ' output has exactly the D-07 keys');
        check(parsed !== null && result.text === JSON.stringify(parsed), mode + ' output is compact JSON');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run() {
  startCapture();
  try {
    mcp = await loadMcp();
    await partContract();
  } finally {
    stopCapture();
    if (mcp) mcp.resetInventory();
  }

  out('\n--- console and stderr never carry a submitted value (T-66.1-04) ---');
  const leaked = captured.filter((line) => line.includes('SENTINEL'));
  check(captured.length > 0, 'console/stderr output was captured during the run (' + captured.length + ' lines)');
  check(leaked.length === 0, 'no captured console or stderr text contains a SENTINEL value');
  if (leaked.length > 0) out('  DIAG: first leaked line: ' + JSON.stringify(leaked[0].slice(0, 200)));

  out('\nmcp-settings-tool-contract: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  stopCapture();
  failed += 1;
  ORIGINAL_STDERR_WRITE.call(process.stderr, '  FAIL: test harness threw: ' + describeError(err) + '\n');
  out('\nmcp-settings-tool-contract: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(1);
});
