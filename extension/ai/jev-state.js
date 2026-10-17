/**
 * Phase 67 (JEV-03, JEV-06, JEV-07) -- FsbJevState, the extension half of the
 * Jev wire contract.
 *
 * - CONTRACT: a hand-mirrored, deeply frozen copy of the server contract.
 *   The twin is showcase/server/src/jev/contract.js (the server image cannot
 *   load extension files, D-03), and tests/jev-contract-parity.test.js
 *   enforces deep equality, so both copies change in the same commit.
 * - scrubText / matchesSecret / filterInjection / luhnValid: behaviourally
 *   identical mirrors of showcase/server/src/jev/scrubber.js (same sources,
 *   flags, order and placeholders; D-19, D-21). The injection list also
 *   mirrors sanitizePageContent in ai/ai-integration.js.
 * - validateRequest: the server request validator's rules, in the same order
 *   (showcase/server/src/jev/validator.js; D-10, D-11, D-18, D-19, D-20).
 *
 * Inert by design (D-17): loading this file reads no browser API, makes no
 * network call, schedules nothing and touches no storage. Nothing in the
 * extension calls it in Phase 67.
 */
(function initFsbJevState(root) {
  'use strict';

  function deepFreeze(node) {
    if (node !== null && typeof node === 'object' && !Object.isFrozen(node)) {
      Object.keys(node).forEach(function freezeChild(key) { deepFreeze(node[key]); });
      Object.freeze(node);
    }
    return node;
  }

  // ---------------------------------------------------------------------------
  // CONTRACT (mirror of showcase/server/src/jev/contract.js)
  // ---------------------------------------------------------------------------

  // D-16: the locked, closed fallback enum. Order is part of the contract.
  var FALLBACK_REASONS = [
    // Gateway policy
    'disabled',
    'not_configured',
    'invalid_request',
    'payload_too_large',
    'sensitive_goal',
    'busy',
    'spend_cap_reached',
    // Upstream-derived
    'timeout',
    'rate_limited',
    'upstream_overloaded',
    'auth_error',
    'upstream_billing',
    'unavailable_model',
    'upstream_rejected',
    'upstream_error',
    'invalid_response',
    // Client-only (network_error, aborted); server_error also comes from the
    // gateway's router-local error handler (D-22).
    'network_error',
    'aborted',
    'server_error'
  ];

  var CLIENT_ONLY_FALLBACK_REASONS = ['network_error', 'aborted'];

  var CONTRACT = deepFreeze({
    SCHEMA_VERSION: 1,

    KINDS: ['operation', 'target', 'completion', 'stuck', 'risk'],
    CHOICE_KINDS: ['operation', 'target'],
    NOUL_KINDS: ['completion', 'stuck', 'risk'],

    OPERATIONS: ['click', 'type_text', 'select_option', 'check_box', 'press_enter', 'hover', 'scroll', 'go_back'],

    RESERVED_OPTION_KEY: 'none_of_the_above',

    ELEMENT_ID_PATTERN: '^e(0|[1-9][0-9]{0,2})$',

    FALLBACK_REASONS: FALLBACK_REASONS.slice(),
    GATEWAY_FALLBACK_REASONS: FALLBACK_REASONS.filter(function notClientOnly(reason) {
      return CLIENT_ONLY_FALLBACK_REASONS.indexOf(reason) === -1;
    }),
    CLIENT_ONLY_FALLBACK_REASONS: CLIENT_ONLY_FALLBACK_REASONS.slice(),

    // The client may cool down in memory on these (D-16); it never stores them.
    NON_TRANSIENT_REASONS: ['disabled', 'not_configured', 'spend_cap_reached', 'auth_error', 'upstream_billing', 'unavailable_model'],

    HTTP_STATUS_BY_REASON: {
      invalid_request: 400,
      sensitive_goal: 400,
      payload_too_large: 413,
      disabled: 503,
      not_configured: 503,
      busy: 503,
      spend_cap_reached: 503,
      timeout: 504,
      rate_limited: 502,
      upstream_overloaded: 502,
      auth_error: 502,
      upstream_billing: 502,
      unavailable_model: 502,
      upstream_rejected: 502,
      upstream_error: 502,
      invalid_response: 502,
      server_error: 500
    },

    CALIBRATION_STATUSES: ['calibrated', 'uncalibrated', 'snapshot_changed'],

    // D-23: Phase 66's source labels; missing numbers are null, never 0.
    USAGE_SOURCES: ['provider', 'unavailable'],
    COST_SOURCES: ['provider', 'estimate', 'unavailable'],

    NOUL_DIRECTION: { completion: 'veto_when_low', stuck: 'flag_when_high', risk: 'flag_when_high' },

    // Code points unless noted. 254 elements plus the catch-all fit Choice's
    // 255-option cap (D-11).
    CAPS: {
      goalChars: 1000,
      originChars: 256,
      pathChars: 512,
      titleChars: 200,
      textChars: 6000,
      labelChars: 80,
      roleChars: 32,
      opsPerElement: 8,
      elements: 254,
      recentActions: 10
    },

    // UTF-8 bytes (D-12).
    BUDGETS: { bodyLimitBytes: 49152, requestByteBudget: 20000, upstreamByteBudget: 28000 },

    KEYS: {
      request: ['v', 'kinds', 'goal', 'page', 'elements', 'recentActions', 'offeredOps', 'proposedAction'],
      requestRequired: ['v', 'kinds', 'goal', 'page', 'elements', 'recentActions', 'offeredOps'],
      page: ['origin', 'path', 'title', 'text'],
      // D-18: no slot for an input's contents, not even an empty one.
      element: ['id', 'role', 'label', 'ops'],
      recentAction: ['op', 'targetId', 'changed'],
      proposedAction: ['op', 'targetId'],
      okResponse: ['ok', 'decisionId', 'instrumentVersion', 'servedModel', 'calibration', 'decisions', 'usage', 'cost', 'latencyMs'],
      fallbackResponse: ['ok', 'fallback', 'servedModel', 'httpStatus', 'latencyMs'],
      calibration: ['status', 'profileId'],
      choiceDecision: ['choice', 'confidence', 'probabilities', 'threshold', 'meetsThreshold'],
      noulDecision: ['p', 'threshold', 'meetsThreshold'],
      usage: ['inputTokens', 'source'],
      cost: ['usd', 'source']
    },

    // D-29: case-insensitive regex sources. No wire key may match any of them.
    APPROVAL_KEY_DENYLIST: ['approv', 'authori[sz]', 'allow', 'skip', 'bypass', 'consent', 'confirm', 'permit', 'grant', 'override']
  });

  /** True when `key` matches a deny-list source, case-insensitively. */
  function isApprovalLikeKey(key) {
    if (typeof key !== 'string') return false;
    return CONTRACT.APPROVAL_KEY_DENYLIST.some(function matches(source) {
      return new RegExp(source, 'i').test(key);
    });
  }

  // ---------------------------------------------------------------------------
  // Scrubber and injection filter (mirror of showcase/server/src/jev/scrubber.js)
  // ---------------------------------------------------------------------------

  var PLACEHOLDERS = Object.freeze({
    pem: '[REDACTED_PRIVATE_KEY]',
    jwt: '[REDACTED_JWT]',
    bearer: 'Bearer [REDACTED_TOKEN]',
    keyPrefix: '[REDACTED_API_KEY]',
    fsbBridge: '[REDACTED_FSB_BRIDGE_SECRET]',
    card: '[REDACTED_CARD]',
    highEntropy: '[REDACTED_TOKEN]'
  });

  /** Luhn checksum over a string of ASCII digits only. Anything else is false. */
  function luhnValid(digits) {
    if (typeof digits !== 'string' || !/^[0-9]+$/.test(digits)) return false;
    var sum = 0;
    var double = false;
    for (var i = digits.length - 1; i >= 0; i -= 1) {
      var d = digits.charCodeAt(i) - 48;
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  }

  function replaceCard(match) {
    var digits = match.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return PLACEHOLDERS.card;
    return match;
  }

  function replaceHighEntropy(match) {
    if (!/[A-Z]/.test(match) || !/[a-z]/.test(match) || !/[0-9]/.test(match)) return match;
    var segments = match.split(/[-_/+=]/);
    var hasMixedLongSegment = segments.some(function mixedLong(segment) {
      return segment.length >= 16 && /[A-Za-z]/.test(segment) && /[0-9]/.test(segment);
    });
    return hasMixedLongSegment ? PLACEHOLDERS.highEntropy : match;
  }

  /** The scrub patterns in application order, with fresh regex literals per call. */
  function buildScrubPatterns() {
    return [
      {
        name: 'pem',
        re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        replacement: PLACEHOLDERS.pem
      },
      {
        name: 'jwt',
        re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
        replacement: PLACEHOLDERS.jwt
      },
      {
        name: 'bearer',
        re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
        replacement: PLACEHOLDERS.bearer
      },
      {
        name: 'keyPrefix',
        re: /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|gh[po]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bpas]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/g,
        replacement: PLACEHOLDERS.keyPrefix
      },
      {
        name: 'fsbBridge',
        re: /fsb-auth\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
        replacement: PLACEHOLDERS.fsbBridge
      },
      {
        name: 'card',
        re: /\b[0-9](?:[ -]?[0-9]){12,18}\b/g,
        replacement: replaceCard
      },
      {
        name: 'highEntropy',
        re: /[A-Za-z0-9+/=_-]{32,}/g,
        replacement: replaceHighEntropy
      }
    ];
  }

  /**
   * The 10 sanitizePageContent INJECTION_PATTERNS (ai/ai-integration.js), same
   * sources and flags, fresh per call.
   */
  function buildInjectionPatterns() {
    return [
      /ignore\s+(all\s+)?previous\s+instructions/gi,
      /you\s+are\s+now\s+(a|an)\b/gi,
      /system\s*prompt/gi,
      /\<\/?(?:system|instruction|prompt|override|admin|root|command|directive)\s*\>/gi,
      /IMPORTANT\s*:\s*(?:ignore|forget|disregard|override|bypass)/gi,
      /(?:disregard|forget)\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions|rules|context)/gi,
      /you\s+must\s+(?:now|instead)\s+(?:act|behave|respond)\s+as/gi,
      /\[\s*(?:SYSTEM|INST|ADMIN|ROOT)\s*\]/gi,
      /BEGIN\s+(?:NEW\s+)?(?:SYSTEM|INSTRUCTIONS?|PROMPT)/gi,
      /END\s+(?:OF\s+)?(?:SYSTEM|INSTRUCTIONS?|PROMPT)/gi
    ];
  }

  /** Replace every secret match with its typed placeholder. Non-strings pass through. */
  function scrubText(s) {
    if (typeof s !== 'string') return s;
    var out = s;
    buildScrubPatterns().forEach(function applyPattern(pattern) {
      out = out.replace(pattern.re, pattern.replacement);
    });
    return out;
  }

  /** True when scrubText would change `s`, i.e. `s` holds at least one secret. */
  function matchesSecret(s) {
    return typeof s === 'string' && scrubText(s) !== s;
  }

  /** Replace each known injection phrase with [FILTERED]. Never truncates. */
  function filterInjection(s) {
    if (typeof s !== 'string') return s;
    var out = s;
    buildInjectionPatterns().forEach(function applyPattern(re) {
      out = out.replace(re, '[FILTERED]');
    });
    return out;
  }

  var PATTERN_SOURCES = Object.freeze(buildScrubPatterns().map(function describe(pattern) {
    return Object.freeze({ name: pattern.name, source: pattern.re.source, flags: pattern.re.flags });
  }));

  var INJECTION_PATTERN_SOURCES = Object.freeze(buildInjectionPatterns().map(function describe(re) {
    return Object.freeze({ source: re.source, flags: re.flags });
  }));

  // ---------------------------------------------------------------------------
  // Request validator (mirror of showcase/server/src/jev/validator.js)
  // ---------------------------------------------------------------------------

  var KEYS = CONTRACT.KEYS;
  var CAPS = CONTRACT.CAPS;
  var OPERATIONS = CONTRACT.OPERATIONS;

  // Non-global regexes: .test() on them carries no lastIndex state.
  var ELEMENT_ID_RE = new RegExp(CONTRACT.ELEMENT_ID_PATTERN);
  // Scheme, host (bracketed IPv6 or a DNS/IPv4 host) and an optional port.
  // Nothing after the authority (D-20).
  var ORIGIN_RE = /^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$/;

  /** Length in Unicode code points (never UTF-16 code units). Non-strings are 0. */
  function codePointLength(s) {
    return typeof s === 'string' ? Array.from(s).length : 0;
  }

  function isPlainObject(node) {
    return node !== null && typeof node === 'object' && !Array.isArray(node);
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** Plain object whose own keys are all allowed and include every required key. */
  function hasExactKeys(obj, allowed, required) {
    if (!isPlainObject(obj)) return false;
    var own = Object.keys(obj);
    for (var i = 0; i < own.length; i += 1) {
      if (allowed.indexOf(own[i]) === -1) return false;
    }
    for (var j = 0; j < required.length; j += 1) {
      if (!hasOwn(obj, required[j])) return false;
    }
    return true;
  }

  function isStringWithin(s, maxCodePoints) {
    return typeof s === 'string' && codePointLength(s) <= maxCodePoints;
  }

  function isUniqueArray(list) {
    return new Set(list).size === list.length;
  }

  /** Array (possibly empty) of unique members of `vocabulary`. */
  function isUniqueSubset(list, vocabulary) {
    return Array.isArray(list) && isUniqueArray(list) && list.every(function inVocabulary(item) {
      return vocabulary.indexOf(item) !== -1;
    });
  }

  function isElementId(s) {
    return typeof s === 'string' && ELEMENT_ID_RE.test(s);
  }

  function validKinds(kinds) {
    return Array.isArray(kinds) && kinds.length > 0 && isUniqueSubset(kinds, CONTRACT.KINDS);
  }

  function validGoal(goal) {
    return typeof goal === 'string' && goal.trim().length > 0 && codePointLength(goal) <= CAPS.goalChars;
  }

  function validPage(page) {
    if (!hasExactKeys(page, KEYS.page, KEYS.page)) return false;
    if (!isStringWithin(page.origin, CAPS.originChars) || !ORIGIN_RE.test(page.origin)) return false;
    if (!isStringWithin(page.path, CAPS.pathChars) || page.path.charAt(0) !== '/') return false;
    if (page.path.indexOf('?') !== -1 || page.path.indexOf('#') !== -1) return false;
    if (!isStringWithin(page.title, CAPS.titleChars)) return false;
    if (!isStringWithin(page.text, CAPS.textChars)) return false;
    return true;
  }

  function validElement(element, seenIds) {
    if (!hasExactKeys(element, KEYS.element, KEYS.element)) return false;
    if (!isElementId(element.id) || seenIds.has(element.id)) return false;
    seenIds.add(element.id);
    if (!isStringWithin(element.role, CAPS.roleChars) || element.role.length === 0) return false;
    if (!isStringWithin(element.label, CAPS.labelChars)) return false;
    var ops = element.ops;
    if (!isUniqueSubset(ops, OPERATIONS) || ops.length === 0 || ops.length > CAPS.opsPerElement) return false;
    return true;
  }

  function validElements(elements, seenIds) {
    if (!Array.isArray(elements) || elements.length > CAPS.elements) return false;
    return elements.every(function eachElement(element) { return validElement(element, seenIds); });
  }

  function validRecentAction(action) {
    if (!hasExactKeys(action, KEYS.recentAction, KEYS.recentAction)) return false;
    if (OPERATIONS.indexOf(action.op) === -1) return false;
    if (action.targetId !== null && !isElementId(action.targetId)) return false;
    return typeof action.changed === 'boolean';
  }

  function validRecentActions(actions) {
    if (!Array.isArray(actions) || actions.length > CAPS.recentActions) return false;
    return actions.every(validRecentAction);
  }

  function validProposedAction(action, elementIds) {
    if (!hasExactKeys(action, KEYS.proposedAction, KEYS.proposedAction)) return false;
    if (OPERATIONS.indexOf(action.op) === -1) return false;
    return action.targetId === null || (typeof action.targetId === 'string' && elementIds.has(action.targetId));
  }

  /** True when the whole request shape passes; checks run in the server's order. */
  function validShape(body) {
    if (!isPlainObject(body)) return false;
    var own = Object.keys(body);
    for (var i = 0; i < own.length; i += 1) {
      if (KEYS.request.indexOf(own[i]) === -1) return false;
    }
    for (var j = 0; j < KEYS.requestRequired.length; j += 1) {
      if (!hasOwn(body, KEYS.requestRequired[j])) return false;
    }
    if (body.v !== CONTRACT.SCHEMA_VERSION) return false;
    if (!validKinds(body.kinds)) return false;
    if (!validGoal(body.goal)) return false;
    if (!validPage(body.page)) return false;
    var elementIds = new Set();
    if (!validElements(body.elements, elementIds)) return false;
    if (!validRecentActions(body.recentActions)) return false;
    if (!isUniqueSubset(body.offeredOps, OPERATIONS)) return false;

    // Cross-field rules.
    var kinds = body.kinds;
    if (kinds.indexOf('operation') !== -1 && body.offeredOps.length === 0) return false;
    if (kinds.indexOf('target') !== -1 && body.elements.length === 0) return false;
    var hasProposedAction = hasOwn(body, 'proposedAction');
    if (hasProposedAction !== (kinds.indexOf('risk') !== -1)) return false;
    if (hasProposedAction && !validProposedAction(body.proposedAction, elementIds)) return false;
    return true;
  }

  /**
   * Validate one request with the server's rules and reason order.
   * @returns {{ok:true}|{ok:false, reason:'invalid_request'|'sensitive_goal'}}
   */
  function validateRequest(body) {
    if (!validShape(body)) return { ok: false, reason: 'invalid_request' };
    if (matchesSecret(body.goal)) return { ok: false, reason: 'sensitive_goal' };
    return { ok: true };
  }

  var api = {
    CONTRACT: CONTRACT,
    isApprovalLikeKey: isApprovalLikeKey,
    scrubText: scrubText,
    matchesSecret: matchesSecret,
    filterInjection: filterInjection,
    luhnValid: luhnValid,
    PATTERN_SOURCES: PATTERN_SOURCES,
    INJECTION_PATTERN_SOURCES: INJECTION_PATTERN_SOURCES,
    PLACEHOLDERS: PLACEHOLDERS,
    validateRequest: validateRequest,
    codePointLength: codePointLength
  };
  root.FsbJevState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
