/**
 * Phase 67 (JEV-01, JEV-02, JEV-06, JEV-07) -- FsbJevClient, the extension's
 * Jev decision client. Phases 68 and 70 call it; nothing calls it in Phase 67.
 *
 * - decide(request, {signal, timeoutMs}) posts one sanitized request to FSB's
 *   own gateway and resolves to exactly one of two shapes, JevOk or
 *   JevFallback. It never throws and never rejects (D-15).
 * - The endpoint is a fixed constant. The extension holds no Jev or upstream
 *   key, reads no setting and never follows the user-editable Sync server
 *   URL (D-01, D-09). Requests omit credentials and carry nothing in the
 *   query string.
 * - Local checks cost no network: an invalid request, a secret in the goal
 *   or an oversized body is answered here (D-16, D-19).
 * - The response body is mapped first and the HTTP status only when the body
 *   is missing, not JSON or not an exact D-15 shape. A response with any
 *   unknown or approval-like key is never accepted (D-15, D-29).
 *
 * Inert by design (D-17): loading this file makes no network call, schedules
 * nothing, reads no storage and touches no browser API. fetch is resolved
 * when decide() runs, never at load.
 */
(function initFsbJevClient(root) {
  'use strict';

  /**
   * The locked D-16 fallback enum (mirrored and parity-tested in
   * FsbJevState.CONTRACT.FALLBACK_REASONS).
   * @typedef {'disabled'|'not_configured'|'invalid_request'|'payload_too_large'|'sensitive_goal'|'busy'|
   *   'spend_cap_reached'|'timeout'|'rate_limited'|'upstream_overloaded'|'auth_error'|'upstream_billing'|
   *   'unavailable_model'|'upstream_rejected'|'upstream_error'|'invalid_response'|
   *   'network_error'|'aborted'|'server_error'} JevFallbackReason
   */

  /**
   * A Choice answer (operation or target).
   * @typedef {{choice:string, confidence:number, probabilities:Object<string,number>,
   *   threshold:number|null, meetsThreshold:boolean}} JevChoiceDecision
   */

  /**
   * A Noul answer (completion, stuck or risk).
   * @typedef {{p:number, threshold:number|null, meetsThreshold:boolean}} JevNoulDecision
   */

  /**
   * A successful decision. latencyMs is measured by the client, end to end.
   * @typedef {{ok:true, decisionId:string, instrumentVersion:string, servedModel:string,
   *   calibration:{status:'calibrated'|'uncalibrated'|'snapshot_changed', profileId:string},
   *   decisions:{operation?:JevChoiceDecision, target?:JevChoiceDecision,
   *              completion?:JevNoulDecision, stuck?:JevNoulDecision, risk?:JevNoulDecision},
   *   usage:{inputTokens:number|null, source:'provider'|'unavailable'},
   *   cost:{usd:number|null, source:'provider'|'estimate'|'unavailable'}, latencyMs:number}} JevOk
   */

  /**
   * A typed fallback. httpStatus is the HTTP status the client received from
   * the gateway, or null when there was no response. latencyMs is measured by
   * the client. Every fallback means: take the existing, non-Jev path (D-30).
   * @typedef {{ok:false, fallback:JevFallbackReason, servedModel:string|null,
   *   httpStatus:number|null, latencyMs:number}} JevFallback
   */

  /** The fixed gateway endpoint (D-09). Never a setting, never the Sync server URL. */
  var ENDPOINT = 'https://full-selfbrowsing.com/api/jev/decide';
  /** The client deadline: the gateway's upstream timeout plus network margin (D-15). */
  var DEFAULT_TIMEOUT_MS = 2500;
  /** The in-memory cool-down after a non-transient fallback (D-16). */
  var COOLDOWN_MS = 60000;
  /** The longest spend_cap_reached cool-down (until the next UTC midnight, at most 1 h). */
  var MAX_SPEND_COOLDOWN_MS = 3600000;

  /** Response text longer than this is never parsed; it maps by status. */
  var MAX_RESPONSE_CHARS = 65536;
  /** The optional attribution header value: a self-issued 64-char lowercase hex key (D-07). */
  var HASH_KEY_RE = /^[a-f0-9]{64}$/;

  function isObjectLike(node) {
    return node !== null && typeof node === 'object';
  }

  /** FsbJevState, resolved at call time: the worker global, else require under Node. */
  function resolveState() {
    try {
      if (root && isObjectLike(root.FsbJevState)) return root.FsbJevState;
      if (typeof require === 'function') {
        var loaded = require('./jev-state.js');
        return isObjectLike(loaded) ? loaded : null;
      }
    } catch (_e) {
      return null;
    }
    return null;
  }

  function isKnownReason(reason) {
    var state = resolveState();
    if (!state) return reason === 'invalid_request';
    return state.CONTRACT.FALLBACK_REASONS.indexOf(reason) !== -1;
  }

  /** An HTTP status a real response can carry. */
  function isReceivedStatus(status) {
    return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599;
  }

  /**
   * The status-only mapping (D-16). Used only when the body is missing, not
   * JSON, or not an exact D-15 shape (for example a Fly-edge 502 page).
   */
  function reasonForStatus(status) {
    if (status >= 200 && status <= 299) return 'invalid_response';
    if (status === 413) return 'payload_too_large';
    if (status === 429) return 'rate_limited';
    if (status >= 400 && status <= 499) return 'invalid_request';
    if (status === 504) return 'timeout';
    if (status >= 500 && status <= 599) return 'server_error';
    return 'invalid_response';
  }

  /** The exact JevFallback shape. An unknown reason becomes invalid_response. */
  function fail(reason, servedModel, httpStatus, latencyMs) {
    return {
      ok: false,
      fallback: isKnownReason(reason) ? reason : 'invalid_response',
      servedModel: typeof servedModel === 'string' && servedModel.length > 0 ? servedModel : null,
      httpStatus: isReceivedStatus(httpStatus) ? httpStatus : null,
      latencyMs: latencyMs
    };
  }

  /** The exact JevOk shape from a validated gateway body, with the client's latency. */
  function okResult(value, latencyMs) {
    return {
      ok: true,
      decisionId: value.decisionId,
      instrumentVersion: value.instrumentVersion,
      servedModel: value.servedModel,
      calibration: value.calibration,
      decisions: value.decisions,
      usage: value.usage,
      cost: value.cost,
      latencyMs: latencyMs
    };
  }

  /** Call fn() and always get a promise back, even when fn throws synchronously. */
  function invoke(fn) {
    return new Promise(function run(resolve) { resolve(fn()); });
  }

  /** getHashKey() as a promise of a well-formed key or null. Never rejects. */
  function readHashKey(getHashKey) {
    return invoke(getHashKey).then(function keep(key) {
      return typeof key === 'string' && HASH_KEY_RE.test(key) ? key : null;
    }, function drop() {
      return null;
    });
  }

  /**
   * Create a client. Every option is for tests and tooling; the extension uses
   * the defaults.
   * @param {{endpoint?:string, fetchImpl?:Function, now?:function():number,
   *   getHashKey?:(function():(string|null|Promise<string|null>))|null,
   *   setTimeoutImpl?:Function, clearTimeoutImpl?:Function}} [opts]
   * @returns {{decide:function(Object, {signal?:AbortSignal, timeoutMs?:number}=):Promise<JevOk|JevFallback>}}
   */
  function createJevClient(opts) {
    var options = isObjectLike(opts) ? opts : {};
    var endpoint = typeof options.endpoint === 'string' && options.endpoint.length > 0 ? options.endpoint : ENDPOINT;
    var fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : null;
    var nowImpl = typeof options.now === 'function' ? options.now : null;
    var getHashKey = typeof options.getHashKey === 'function' ? options.getHashKey : null;

    /** The injected clock, or Date.now; null when it misbehaves. */
    function clock() {
      try {
        var t = nowImpl ? nowImpl() : Date.now();
        return typeof t === 'number' && Number.isFinite(t) ? t : null;
      } catch (_e) {
        return null;
      }
    }

    function elapsedSince(started) {
      var t = clock();
      if (started === null || t === null) return 0;
      return t > started ? t - started : 0;
    }

    /**
     * Ask the gateway for one decision. Never throws, never rejects.
     * @param {Object} request - a request built by FsbJevState.buildRequest.
     * @param {{signal?:AbortSignal, timeoutMs?:number}} [callOpts]
     * @returns {Promise<JevOk|JevFallback>}
     */
    async function decide(request, callOpts) {
      var started = clock();
      var phase = 'local';
      var status = null;
      try {
        // 1. Local checks: no network.
        var state = resolveState();
        if (!state) return fail('invalid_request', null, null, elapsedSince(started));
        var verdict = state.validateRequest(request);
        if (!isObjectLike(verdict) || verdict.ok !== true) {
          var reason = isObjectLike(verdict) && verdict.reason === 'sensitive_goal' ? 'sensitive_goal' : 'invalid_request';
          return fail(reason, null, null, elapsedSince(started));
        }
        var bodyText = JSON.stringify(request);
        if (state.utf8ByteLength(bodyText) > state.CONTRACT.BUDGETS.bodyLimitBytes) {
          return fail('payload_too_large', null, null, elapsedSince(started));
        }
        var call = isObjectLike(callOpts) ? callOpts : {};
        var callerSignal = call.signal;
        if (isObjectLike(callerSignal) && callerSignal.aborted === true) {
          return fail('aborted', null, null, elapsedSince(started));
        }

        // 2. One POST to the fixed endpoint.
        phase = 'network';
        var fetchFn = fetchImpl || root.fetch;
        if (typeof fetchFn !== 'function') return fail('network_error', null, null, elapsedSince(started));
        var Controller = root.AbortController;
        var controller = typeof Controller === 'function' ? new Controller() : null;
        var headers = { 'Content-Type': 'application/json' };
        if (getHashKey) {
          var hashKey = await readHashKey(getHashKey);
          if (hashKey) headers['X-FSB-Hash-Key'] = hashKey;
        }
        var init = {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          headers: headers,
          body: bodyText,
          signal: controller ? controller.signal : undefined
        };
        var res = await invoke(function send() { return fetchFn(endpoint, init); });
        if (!isObjectLike(res) || !isReceivedStatus(res.status)) {
          return fail('network_error', null, null, elapsedSince(started));
        }
        status = res.status;

        // 3. Body first, then the status.
        var text = null;
        if (typeof res.text === 'function') {
          text = await invoke(function read() { return res.text(); }).then(function asText(value) {
            return typeof value === 'string' ? value : null;
          }, function unreadable() {
            return null;
          });
        }
        var parsed;
        var hasBody = false;
        if (typeof text === 'string' && text.length > 0 && text.length <= MAX_RESPONSE_CHARS) {
          try {
            parsed = JSON.parse(text);
            hasBody = true;
          } catch (_e) {
            hasBody = false;
          }
        }
        if (hasBody) {
          var checked = state.validateGatewayResponse(parsed, request);
          if (isObjectLike(checked) && checked.ok === true) {
            var body = checked.value;
            if (body.ok === true) return okResult(body, elapsedSince(started));
            return fail(body.fallback, body.servedModel, status, elapsedSince(started));
          }
        }
        return fail(reasonForStatus(status), null, status, elapsedSince(started));
      } catch (_e) {
        if (phase === 'local') return fail('invalid_request', null, null, elapsedSince(started));
        return fail('network_error', null, status, elapsedSince(started));
      }
    }

    return { decide: decide };
  }

  // The default instance. Creating it reads nothing and schedules nothing.
  var defaultClient = createJevClient();

  var api = {
    ENDPOINT: ENDPOINT,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    COOLDOWN_MS: COOLDOWN_MS,
    MAX_SPEND_COOLDOWN_MS: MAX_SPEND_COOLDOWN_MS,
    createJevClient: createJevClient,
    decide: defaultClient.decide
  };
  root.FsbJevClient = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
