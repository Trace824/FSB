'use strict';

/**
 * Phase 225-01 (Task 2): in-flight session lookup for stop_task and
 * get_session_detail.
 *
 * Today the dispatcher's session lookup only consults the COMPLETED-sessions
 * history store (automationLogger.loadSession). A session that is currently
 * running lives in the activeSessions map, never in history yet, so MCP
 * surfaces a misleading "Session not found" / "Page navigation" error while
 * the user can clearly see the run via get_task_status.
 *
 * These tests exercise handleGetSessionMessageRoute and handleStopAutomationRoute
 * against a minimal harness that mocks activeSessions + automationLogger.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  PASS:', msg);
  } else {
    failed++;
    console.error('  FAIL:', msg);
  }
}

function buildHarness({ activeSessionEntries = [], historicalSession = null, stopHandler = null } = {}) {
  const dispatcherSource = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'ws', 'mcp-tool-dispatcher.js'),
    'utf8',
  );

  const context = {
    console,
    Math,
    Date,
    Map,
    Set,
    Array,
    Object,
    Number,
    Boolean,
    String,
    Promise,
    URL,
    Blob: typeof Blob !== 'undefined' ? Blob : undefined,
    JSON,
    activeSessions: undefined, // populated inside vm to use the same Map class
    automationLogger: {
      loadSession: async (sessionId) => (historicalSession && historicalSession.sessionId === sessionId ? historicalSession : null),
      listSessions: async () => [],
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
    handleStopAutomation: stopHandler || ((req, _sender, sendResponse) => sendResponse({ success: true, sessionId: req.sessionId, stopped: true })),
    require: (modulePath) => {
      // Resolve relative requires from the dispatcher's location.
      if (modulePath.startsWith('../ai/tool-definitions.js')) {
        return require(path.join(__dirname, '..', 'extension', 'ai', 'tool-definitions.js'));
      }
      if (modulePath.startsWith('../utils/mcp-visual-session.js')) {
        return require(path.join(__dirname, '..', 'extension', 'utils', 'mcp-visual-session.js'));
      }
      throw new Error('Unsupported require in test harness: ' + modulePath);
    },
    chrome: {
      tabs: {
        query: async () => [],
      },
    },
    module: { exports: {} },
    globalThis: {},
  };
  context.globalThis = context;
  context.module.exports = {};

  // Initialize activeSessions as a Map constructed inside the vm so
  // dispatcher's `instanceof Map` check passes against the vm's Map class.
  const setupSource = `
    activeSessions = new Map();
    if (typeof __seed_active_session_entries !== 'undefined') {
      for (const [key, value] of __seed_active_session_entries) {
        activeSessions.set(key, value);
      }
    }
  `;
  context.__seed_active_session_entries = activeSessionEntries;
  vm.runInNewContext(setupSource + '\n' + dispatcherSource, context, { filename: 'ws/mcp-tool-dispatcher.js' });

  return {
    dispatcher: context.module.exports,
    context,
  };
}

async function runGetSessionDetailFallbackCase() {
  console.log('\n--- get_session_detail returns in-flight snapshot ---');

  const sessionId = 'session_active_1';
  const liveSession = {
    sessionId,
    status: 'running',
    task: 'Open Excalidraw and draw a triangle',
    startTime: Date.now() - 5000,
    iterationCount: 4,
    maxIterations: 20,
    actionHistory: [
      { tool: 'click', timestamp: Date.now() - 100, iteration: 4, params: { selector: '#draw-tool' }, result: { success: true } },
    ],
    tabId: 17,
    lastUrl: 'https://excalidraw.com/',
  };
  const { dispatcher } = buildHarness({ activeSessionEntries: [[sessionId, liveSession]] });

  const result = await dispatcher.dispatchMcpMessageRoute({
    type: 'mcp:get-session',
    payload: { sessionId },
  });

  assert(result && result.success === true, 'in-flight get_session_detail returns success=true');
  assert(result && result.inFlight === true, 'in-flight get_session_detail flags inFlight: true');
  assert(result && result.session && result.session.final === false, 'in-flight snapshot carries final: false');
  assert(result && result.session && result.session.sessionId === sessionId, 'snapshot includes sessionId');
  assert(result && result.session && result.session.actionCount === 1, 'snapshot includes actionCount');
  assert(result && result.session && typeof result.session.note === 'string' && result.session.note.length > 0, 'snapshot includes a human-readable note');
}

async function runGetSessionDetailMissingCase() {
  console.log('\n--- get_session_detail surfaces session_not_found for unknown id ---');

  const { dispatcher } = buildHarness();

  const result = await dispatcher.dispatchMcpMessageRoute({
    type: 'mcp:get-session',
    payload: { sessionId: 'session_does_not_exist' },
  });

  assert(result && result.success === false, 'unknown session returns success=false');
  assert(result && result.errorCode === 'session_not_found', 'unknown session returns errorCode=session_not_found (not generic action_rejected)');
  assert(result && typeof result.error === 'string' && result.error.includes('not found'), 'error message describes the actual failure');
  assert(result && typeof result.recoveryHint === 'string' && result.recoveryHint.includes('list_sessions') && result.recoveryHint.includes('get_task_status'), 'recovery hint suggests list_sessions and get_task_status');
}

async function runStopTaskInFlightCase() {
  console.log('\n--- stop_task resolves in-flight session when no sessionId provided ---');

  const sessionId = 'session_active_for_stop';
  const liveSession = { sessionId, status: 'running', task: 'long task', startTime: Date.now(), iterationCount: 1, actionHistory: [], tabId: 9 };

  let stopRequest = null;
  const { dispatcher } = buildHarness({
    activeSessionEntries: [[sessionId, liveSession]],
    stopHandler: (req, _sender, sendResponse) => {
      stopRequest = req;
      sendResponse({ success: true, sessionId: req.sessionId, stopped: true });
    },
  });

  const result = await dispatcher.dispatchMcpMessageRoute({
    type: 'mcp:stop-automation',
    payload: {}, // MCP stop_task tool ships no sessionId in its schema
  });

  assert(result && result.success === true, 'stop_task on in-flight session returns success');
  assert(stopRequest && stopRequest.sessionId === sessionId, 'dispatcher forwarded the active sessionId to handleStopAutomation');
}

async function runStopTaskNoSessionCase() {
  console.log('\n--- stop_task returns session_not_found when no in-flight session ---');

  const { dispatcher } = buildHarness();

  const result = await dispatcher.dispatchMcpMessageRoute({
    type: 'mcp:stop-automation',
    payload: {},
  });

  assert(result && result.success === false, 'stop_task with no active session returns success=false');
  assert(result && result.errorCode === 'session_not_found', 'stop_task surfaces session_not_found error code');
  assert(result && typeof result.recoveryHint === 'string' && result.recoveryHint.includes('get_task_status'), 'stop_task recovery hint suggests get_task_status');
}

// ---- Phase 66 (MEAS-01/MEAS-02): call timing and session measurement ---------

const DISPATCHER_PATH = path.join(__dirname, '..', 'extension', 'ws', 'mcp-tool-dispatcher.js');
// Symbol.for is shared across realms, so this is the symbol the vm-loaded
// dispatcher reads.
const CALL_TIMING = Symbol.for('fsb.mcp.call-timing');

function stampPayload(payload, receivedAt) {
  Object.defineProperty(payload, CALL_TIMING, {
    value: { receivedAt },
    enumerable: false,
    configurable: true
  });
  return payload;
}

async function runDispatcherMessageRouteTimingCase() {
  console.log('\n--- dispatcher message-route recorder entry carries call timing ---');

  const { dispatcher, context } = buildHarness();
  const recorded = [];
  // FsbSpreadsheetRecordRedaction stays undefined, so the plain branch runs.
  context.fsbMcpSessionRecorder = { recordDispatch: (entry) => { recorded.push(entry); } };

  const receivedAt = Date.now() - 30;
  const stamped = stampPayload({ limit: 5 }, receivedAt);
  const response = await dispatcher.dispatchMcpMessageRoute({ type: 'mcp:list-sessions', payload: stamped });
  assert(response && response.success === true, 'a stamped mcp:list-sessions call still succeeds');
  assert(recorded.length === 1, 'the plain recordDispatch branch records the message route once');
  const timing = recorded[0] && recorded[0].timing;
  assert(!!timing && timing.v === 1 && timing.receivedAt === receivedAt,
    'the recorder entry timing is v1 and carries the ingress receivedAt');
  assert(!!timing && timing.completedAt >= receivedAt && timing.fsbMs === timing.completedAt - timing.receivedAt,
    'completedAt >= receivedAt and fsbMs = completedAt - receivedAt');
  assert(!!timing && timing.fsbMs >= 30, 'fsbMs covers at least the 30 ms since the stamp');
  assert(!JSON.stringify(response).includes('receivedAt') && !Object.prototype.hasOwnProperty.call(response, 'timing'),
    'the timing never reaches the tool response');

  recorded.length = 0;
  await dispatcher.dispatchMcpMessageRoute({ type: 'mcp:list-sessions', payload: { limit: 5 } });
  assert(recorded.length === 1 && recorded[0].timing === null, 'an unstamped call records timing null, never 0');

  recorded.length = 0;
  await dispatcher.dispatchMcpMessageRoute({
    type: 'mcp:list-sessions',
    payload: { timing: { v: 1, receivedAt: 5, completedAt: 10, fsbMs: 5 } }
  });
  assert(recorded.length === 1 && recorded[0].timing === null, 'a caller-supplied string key timing is ignored');
}

async function runDispatcherTimingHelpersCase() {
  console.log('\n--- readDispatcherCallStamp / buildDispatcherCallTiming validate the stamp ---');

  const { dispatcher } = buildHarness();
  const read = dispatcher.readDispatcherCallStamp;
  const build = dispatcher.buildDispatcherCallTiming;
  assert(typeof read === 'function' && typeof build === 'function', 'both helpers are exported (test-only)');
  if (typeof read !== 'function' || typeof build !== 'function') return;

  assert(read({ timing: { v: 1, receivedAt: 1000 }, receivedAt: 1000 }) === null,
    'a payload with only string keys (timing, receivedAt) reads null');
  for (const bad of [1.5, -1, '1000', NaN, Infinity, null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert(read(stampPayload({}, bad)) === null, 'receivedAt ' + String(bad) + ' reads null');
  }
  for (const nonObject of [null, undefined, 'payload', 42, true]) {
    assert(read(nonObject) === null, 'non-object payload ' + String(nonObject) + ' reads null');
  }
  const scalarStamp = {};
  Object.defineProperty(scalarStamp, CALL_TIMING, { value: 1000, enumerable: false, configurable: true });
  assert(read(scalarStamp) === null, 'a stamp that is not an object reads null');
  const valid = read(stampPayload({}, 1000));
  assert(!!valid && valid.receivedAt === 1000 && Object.keys(valid).length === 1, 'a valid stamp reads { receivedAt }');

  assert(build(null) === null, 'buildDispatcherCallTiming(null) is null');
  assert(build(undefined) === null, 'buildDispatcherCallTiming(undefined) is null');
  assert(build({ receivedAt: -5 }) === null, 'a negative receivedAt builds null');
  const receivedAt = Date.now() - 25;
  const timing = build({ receivedAt });
  assert(!!timing && timing.v === 1 && timing.receivedAt === receivedAt, 'a valid stamp builds v1 timing');
  assert(!!timing && timing.completedAt >= receivedAt && timing.fsbMs === timing.completedAt - timing.receivedAt,
    'fsbMs equals completedAt - receivedAt');
  assert(!!timing && timing.fsbMs >= 25, 'fsbMs covers the elapsed time');
  assert(build({ receivedAt: Date.now() + 60000 }) === null,
    'a stamp after completion (clock stepped back) builds null, not 0');
}

async function runDispatcherTaskOutcomeTimingCase() {
  console.log('\n--- recordTaskOutcome timing survives visual-session canonicalization ---');

  const { dispatcher, context } = buildHarness();
  const outcomes = [];
  context.fsbMcpSessionRecorder = { recordTaskOutcome: (input) => { outcomes.push(input); } };

  const plainReceivedAt = Date.now() - 40;
  const plainPayload = stampPayload({ tool: 'complete_task', agentId: 'agent-timing' }, plainReceivedAt);
  const plain = await dispatcher.dispatchMcpToolRoute({ tool: 'complete_task', params: { summary: 'Done' }, payload: plainPayload });
  assert(plain && plain.status === 'completed', 'complete_task returns status completed');
  assert(outcomes.length === 1, 'recordTaskOutcome fires once for the confirmed outcome');
  const plainTiming = outcomes[0] && outcomes[0].timing;
  assert(!!plainTiming && plainTiming.receivedAt === plainReceivedAt && plainTiming.fsbMs >= 40 &&
    plainTiming.fsbMs === plainTiming.completedAt - plainTiming.receivedAt,
    'recordTaskOutcome receives validated timing for a stamped call');

  // Visual-session path: canonicalization swaps in the session ownership
  // token through a payload spread, which drops the symbol stamp.
  outcomes.length = 0;
  context.resolveMcpVisualSessionTabId = () => 42;
  context.fsbAgentRegistryInstance = {
    hasAgent: () => true,
    getAgentTabs: () => [42],
    isOwnedBy: () => true,
    getOwner: () => 'agent-visual',
    getTabMetadata: () => ({ ownershipToken: 'session-owner-token' }),
    getAgentWindowId: () => null
  };
  context.handleMcpVisualSessionTaskStatus = (_request, _sender, sendResponse) => {
    sendResponse({ success: true, tool: 'complete_task', status: 'completed' });
  };
  const visualReceivedAt = Date.now() - 35;
  const visualPayload = stampPayload({
    tool: 'complete_task',
    agentId: 'agent-visual',
    ownershipToken: 'agent-token'
  }, visualReceivedAt);
  const visual = await dispatcher.dispatchMcpToolRoute({
    tool: 'complete_task',
    params: { summary: 'Done', session_token: 'visual-token-1' },
    payload: visualPayload
  });
  assert(visual && visual.status === 'completed', 'the visual-session complete_task resolves completed');
  assert(outcomes.length === 1, 'recordTaskOutcome fires once on the visual-session path');
  const recordedPayload = outcomes[0] && outcomes[0].payload;
  assert(!!recordedPayload && recordedPayload !== visualPayload && recordedPayload.ownershipToken === 'session-owner-token',
    'the recorder receives the canonicalized payload copy');
  assert(!!recordedPayload && recordedPayload[CALL_TIMING] === undefined, 'the canonicalized copy has lost the symbol stamp');
  const visualTiming = outcomes[0] && outcomes[0].timing;
  assert(!!visualTiming && visualTiming.receivedAt === visualReceivedAt && visualTiming.fsbMs >= 35,
    'timing read from the original payload still reaches recordTaskOutcome');
}

function runDispatcherTimingSourceContractCase() {
  console.log('\n--- dispatcher call-timing source contract ---');

  const src = fs.readFileSync(DISPATCHER_PATH, 'utf8');
  const toolRoute = src.slice(
    src.indexOf('async function dispatchMcpToolRoute'),
    src.indexOf('async function dispatchMcpMessageRoute')
  );
  const stampAt = toolRoute.indexOf('const callTimingStamp = readDispatcherCallStamp(payload);');
  const canonicalAt = toolRoute.indexOf('canonicalizeVisualSessionTaskParams(tool, params, payload)');
  assert(stampAt > -1 && canonicalAt > -1 && stampAt < canonicalAt,
    'dispatchMcpToolRoute reads the stamp before canonicalizeVisualSessionTaskParams');
  assert(toolRoute.includes('recordTaskOutcome({ tool, params, payload, response, timing: buildDispatcherCallTiming(callTimingStamp) })'),
    'recordTaskOutcome passes timing: buildDispatcherCallTiming(callTimingStamp)');
  assert(!toolRoute.includes('fsbMcpSessionRecorder.recordDispatch'), 'the tool route stays free of session recordDispatch');

  const entryStart = src.indexOf('var sessionRecordEntry = {');
  const entrySpan = entryStart === -1 ? '' : src.slice(entryStart, src.indexOf('};', entryStart));
  assert(entrySpan.includes('timing: buildDispatcherCallTiming(readDispatcherCallStamp(payload))'),
    'the message-route recorder entry carries timing');
  assert((src.match(/Symbol\.for\('fsb\.mcp\.call-timing'\)/g) || []).length === 1,
    'the registry symbol is declared exactly once in the dispatcher');
  assert(src.includes('const MCP_DISPATCHER_CALL_TIMING') && !src.includes('const MCP_BRIDGE_CALL_TIMING'),
    'the dispatcher uses its own identifier, never the bridge client name');
  assert((src.match(/globalThis\.fsbMcpMetricsRecorder\.recordDispatch\(\{[\s\S]*?\}\);/g) || []).length === 2,
    'the two metrics recordDispatch sites are unchanged');
}

async function run() {
  await runGetSessionDetailFallbackCase();
  await runGetSessionDetailMissingCase();
  await runStopTaskInFlightCase();
  await runStopTaskNoSessionCase();
  await runDispatcherMessageRouteTimingCase();
  await runDispatcherTimingHelpersCase();
  await runDispatcherTaskOutcomeTimingCase();
  runDispatcherTimingSourceContractCase();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((error) => {
  failed++;
  console.error('  FAIL: Test harness failed:', error);
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(1);
});
