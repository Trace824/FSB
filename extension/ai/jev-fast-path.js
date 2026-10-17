/**
 * Phase 68 (AUTO-02..AUTO-05) -- FsbFastPath, the autopilot fast-mode core.
 *
 * When fast mode is on and a step is simple, Jev picks one operation and one
 * element from a menu FSB builds; FSB rechecks the element and runs the step
 * through its existing tool loop. This file holds the pure half of that:
 *
 * - constants: the menu cap, the per-command budgets and the fixed strings.
 * - classifyFallback: every Jev fallback reason latches the session, the
 *   command or one iteration (D-16, F9). Unknown reasons fail closed.
 * - toBuilderInput: a content menu becomes a FsbJevState.buildRequest input
 *   holding only the documented element keys (D-11, D-13, D-15). A menu whose
 *   entries buildRequest would all drop declines before any request exists.
 * - evaluateDecision: a decide() result becomes one fast step or a typed
 *   escalation. Jev answers are read only through FsbJevPolicy.accept, which
 *   is necessary and never sufficient (D-16, D-17, D-20, F22).
 * - buildStaticCall: the tool call is built from code-held menu values and
 *   constants only, never from a string Jev returned (D-15, F1, F2).
 *
 * Inert by design: loading this file reads no browser API, schedules nothing,
 * touches no storage and makes no network call. FsbJevState and FsbJevPolicy
 * are resolved when a function runs (the worker global, else require under
 * Node); a missing module makes the caller decline, never throw.
 */
(function initFsbFastPath(root) {
  'use strict';

  function deepFreeze(node) {
    if (node !== null && typeof node === 'object' && !Object.isFrozen(node)) {
      Object.keys(node).forEach(function freezeChild(key) { deepFreeze(node[key]); });
      Object.freeze(node);
    }
    return node;
  }

  // ---------------------------------------------------------------------------
  // Constants (numeric defaults: RESEARCH A3; revisited in V3, M-68-04)
  // ---------------------------------------------------------------------------

  var constants = deepFreeze({
    MENU_CAP: 48,
    FAST_MAX_STEPS: 12,
    FAST_MAX_CALLS: 16,
    FAST_WALL_BUDGET_MS: 20000,
    FAST_MAX_CONSECUTIVE: 3,
    FAST_ESCALATION_LATCH: 3,
    MENU_DEADLINE_MS: 1500,
    SNAPSHOT_DEADLINE_MS: 3000,
    RECENT_ACTIONS_MAX: 10,
    MEASUREMENT_ATTEMPTS_MAX: 100,
    KINDS: ['operation', 'target', 'completion', 'stuck'],
    ELEMENT_OPS: ['click', 'check_box', 'press_enter', 'hover'],
    PAGE_OPS: ['scroll', 'go_back'],
    NEVER_OFFERED: ['type_text', 'select_option'],
    VAULT_TOOL_NAMES: ['fill_credential', 'use_payment_method', 'list_credentials', 'list_payment_methods'],
    FAST_VISUAL_REASON: 'Fast mode: simple step',
    SUMMARY_PREFIX: 'FAST MODE HAND-OFF',
    SNAPSHOT_HEADER: 'Current page snapshot (these refs replace any earlier refs):',
    SNAPSHOT_COLLAPSED: '(Snapshot removed: a later fast-mode hand-off carries the current page.)'
  });

  var ELEMENT_OPS = constants.ELEMENT_OPS;
  var PAGE_OPS = constants.PAGE_OPS;
  var NEVER_OFFERED = constants.NEVER_OFFERED;
  // offeredOps order, and the full operation vocabulary (equal to the
  // contract's OPERATIONS; the suite holds the two together).
  var OFFER_ORDER = ELEMENT_OPS.concat(PAGE_OPS);
  var ALL_OPERATIONS = ELEMENT_OPS.concat(PAGE_OPS, NEVER_OFFERED);

  // The content registry's handle shape (68-02/68-03: j1..j999).
  var HANDLE_RE = /^j[1-9][0-9]{0,2}$/;
  var PAGE_PATH_MAX = 60;

  // buildRequest's drop rules, mirrored to count surviving entries (D-18 of 67).
  var DROPPED_INPUT_TYPES = ['password', 'hidden', 'file'];
  var DROPPED_AUTOCOMPLETE_TOKENS = ['one-time-code', 'current-password', 'new-password'];

  // D-16 / F9: what each fallback reason costs. The six non-transient reasons
  // are read from the contract at call time and join the session class.
  var SESSION_FALLBACKS = ['invalid_request', 'invalid_response'];
  var COMMAND_FALLBACKS = ['sensitive_goal'];
  var ITERATION_FALLBACKS = ['busy', 'timeout', 'rate_limited', 'upstream_overloaded', 'upstream_error',
    'network_error', 'server_error', 'aborted', 'payload_too_large', 'upstream_rejected'];

  // FsbJevPolicy.accept's rejection reasons.
  var ACCEPT_REASONS = ['not_ok', 'not_calibrated', 'kind_absent', 'threshold_null', 'below_threshold', 'catch_all', 'malformed'];
  // Target answers that are not a confident element pick: a page-level op may act on them (F22).
  var NO_ELEMENT_PICK = ['catch_all', 'below_threshold', 'threshold_null'];

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function contains(list, item) {
    return list.indexOf(item) !== -1;
  }

  /** A sibling module, resolved at call time: the worker global, else require under Node. */
  function resolveModule(globalName, file) {
    try {
      if (root && isObject(root[globalName])) return root[globalName];
      if (typeof require === 'function') {
        var loaded = require(file);
        return isObject(loaded) ? loaded : null;
      }
    } catch (_e) {
      return null;
    }
    return null;
  }

  function resolveState() {
    return resolveModule('FsbJevState', './jev-state.js');
  }

  function resolvePolicy() {
    return resolveModule('FsbJevPolicy', './jev-policy.js');
  }

  /** The parsed URL when `url` is an http(s) address, else null (also when URL is unavailable). */
  function parseWebUrl(url) {
    var UrlCtor = root && typeof root.URL === 'function' ? root.URL : null;
    if (!UrlCtor || typeof url !== 'string' || url.length === 0) return null;
    try {
      var parsed = new UrlCtor(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
    } catch (_e) {
      return null;
    }
  }

  /** The path of a page address, with no origin, query or fragment; '' when it does not parse. */
  function pagePathOf(pageUrl) {
    var parsed = parseWebUrl(pageUrl);
    return parsed ? String(parsed.pathname).slice(0, PAGE_PATH_MAX) : '';
  }

  // ---------------------------------------------------------------------------
  // classifyFallback (D-16, F9)
  // ---------------------------------------------------------------------------

  /**
   * The latch a decide() fallback costs: 'session' (fast mode is off for the
   * rest of the session), 'command' (for the rest of this task) or
   * 'iteration' (this iteration only). An unknown reason fails closed to a
   * session latch with reason 'unknown_fallback'. Only decide() results come
   * here: a local buildRequest refusal is a property of the page and latches
   * the command in the caller (sync issue 6).
   * @returns {{latch:'session'|'command'|'iteration', reason:string}}
   */
  function classifyFallback(reason) {
    var state = resolveState();
    var contract = state && isObject(state.CONTRACT) ? state.CONTRACT : null;
    var known = contract && Array.isArray(contract.FALLBACK_REASONS) ? contract.FALLBACK_REASONS : null;
    var nonTransient = contract && Array.isArray(contract.NON_TRANSIENT_REASONS) ? contract.NON_TRANSIENT_REASONS : [];
    if (typeof reason !== 'string') return { latch: 'session', reason: 'unknown_fallback' };
    var listed = contains(nonTransient, reason) || contains(SESSION_FALLBACKS, reason)
      || contains(COMMAND_FALLBACKS, reason) || contains(ITERATION_FALLBACKS, reason);
    if (known ? !contains(known, reason) : !listed) return { latch: 'session', reason: 'unknown_fallback' };
    if (contains(nonTransient, reason) || contains(SESSION_FALLBACKS, reason)) return { latch: 'session', reason: reason };
    if (contains(COMMAND_FALLBACKS, reason)) return { latch: 'command', reason: reason };
    if (contains(ITERATION_FALLBACKS, reason)) return { latch: 'iteration', reason: reason };
    return { latch: 'session', reason: reason };
  }

  // ---------------------------------------------------------------------------
  // toBuilderInput (D-11, D-13, D-15; sync issue 6)
  // ---------------------------------------------------------------------------

  /** The entry's fast-mode operations: element ops only, unique, in entry order. */
  function elementOpsOf(ops) {
    var out = [];
    for (var i = 0; i < ops.length; i += 1) {
      var op = ops[i];
      if (typeof op === 'string' && contains(ELEMENT_OPS, op) && !contains(out, op)) out.push(op);
    }
    return out;
  }

  /**
   * True when buildRequest would keep this reduced element: the same drop
   * rules, with the same trimming and lower-casing (hidden, password/hidden/
   * file input types, cc-* and credential autocomplete tokens,
   * purpose.sensitive, vault-filled ids, no operation, an empty role).
   */
  function survivesDrop(element, vaultFilledIds) {
    if (element.hidden) return false;
    if (typeof element.inputType === 'string'
      && contains(DROPPED_INPUT_TYPES, element.inputType.trim().toLowerCase())) return false;
    if (typeof element.autocomplete === 'string') {
      var tokens = element.autocomplete.trim().toLowerCase().split(/\s+/);
      for (var i = 0; i < tokens.length; i += 1) {
        if (tokens[i].indexOf('cc-') === 0 || contains(DROPPED_AUTOCOMPLETE_TOKENS, tokens[i])) return false;
      }
    }
    if (element.purpose.sensitive) return false;
    if (contains(vaultFilledIds, element.id)) return false;
    return element.ops.length > 0 && element.role.length > 0;
  }

  /** The newest recent actions in the contract vocabulary, targets mapped to current handles or null. */
  function mapRecentActions(list, entriesByHandle) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var action = list[i];
      if (!isObject(action) || typeof action.op !== 'string' || !contains(ALL_OPERATIONS, action.op)) continue;
      var target = typeof action.targetId === 'string' && entriesByHandle.has(action.targetId) ? action.targetId : null;
      out.push({ op: action.op, targetId: target, changed: action.changed === true });
    }
    return out.slice(Math.max(0, out.length - constants.RECENT_ACTIONS_MAX));
  }

  function invalidMenu() {
    return { ok: false, reason: 'menu_invalid' };
  }

  function orEmpty(value) {
    return value === undefined || value === null ? '' : value;
  }

  /**
   * Turn a content menu into a FsbJevState.buildRequest input.
   * ctx: {goal (the user's task text, unchanged), recentActions:[{op, targetId
   * (a handle or null), changed}], navigatedInCommand}.
   *
   * Each entry becomes exactly {id: handle, role, label, ops, inputType,
   * autocomplete, purpose:{sensitive}, hidden}; nothing else an entry carries
   * is copied. offeredOps is the union of the surviving entries' element ops,
   * plus scroll when the page reports more content below and go_back after a
   * navigation in this command. type_text and select_option are never offered.
   *
   * @returns {{ok:true, input:Object, entriesByHandle:Map, offeredOps:string[]}
   *   |{ok:false, reason:'menu_invalid'|'nothing_offerable'}}
   */
  function toBuilderInput(menu, ctx) {
    var c = isObject(ctx) ? ctx : {};
    if (!isObject(menu) || menu.success !== true || !Array.isArray(menu.entries)) return invalidMenu();
    if (parseWebUrl(menu.url) === null) return invalidMenu();
    var title = orEmpty(menu.title);
    var visibleText = orEmpty(menu.visibleText);
    if (typeof title !== 'string' || typeof visibleText !== 'string') return invalidMenu();

    var entriesByHandle = new Map();
    var elements = [];
    var vaultFilledIds = [];
    for (var i = 0; i < menu.entries.length; i += 1) {
      var entry = menu.entries[i];
      if (!isObject(entry) || typeof entry.handle !== 'string' || !HANDLE_RE.test(entry.handle)
        || entriesByHandle.has(entry.handle)) return invalidMenu();
      var label = orEmpty(entry.label);
      if (typeof entry.role !== 'string' || typeof label !== 'string' || !Array.isArray(entry.ops)) return invalidMenu();
      entriesByHandle.set(entry.handle, entry);
      if (entry.vaultFilled === true) vaultFilledIds.push(entry.handle);
      elements.push({
        id: entry.handle,
        role: entry.role,
        label: label,
        ops: elementOpsOf(entry.ops),
        inputType: typeof entry.inputType === 'string' ? entry.inputType : null,
        autocomplete: typeof entry.autocomplete === 'string' ? entry.autocomplete : null,
        purpose: { sensitive: Boolean(isObject(entry.purpose) && entry.purpose.sensitive) },
        hidden: Boolean(entry.hidden)
      });
    }

    var offered = {};
    var survivors = 0;
    var anyEligible = false;
    elements.forEach(function collect(element) {
      if (!survivesDrop(element, vaultFilledIds)) return;
      survivors += 1;
      element.ops.forEach(function mark(op) { offered[op] = true; });
      if (entriesByHandle.get(element.id).fastEligible === true) anyEligible = true;
    });
    if (menu.moreBelow === true) offered.scroll = true;
    if (c.navigatedInCommand === true) offered.go_back = true;
    var pageOpOffered = offered.scroll === true || offered.go_back === true;
    // A target question with zero elements is invalid_request in the 67
    // validator, so a menu with no surviving entry declines here, even when a
    // page op is offered.
    if (survivors === 0 || (!anyEligible && !pageOpOffered)) return { ok: false, reason: 'nothing_offerable' };

    var offeredOps = OFFER_ORDER.filter(function isOffered(op) { return offered[op] === true; });
    var input = {
      kinds: constants.KINDS.slice(),
      goal: c.goal,
      url: menu.url,
      title: title,
      visibleText: visibleText,
      elements: elements,
      vaultFilledIds: vaultFilledIds,
      recentActions: mapRecentActions(c.recentActions, entriesByHandle),
      offeredOps: offeredOps.slice()
    };
    return { ok: true, input: input, entriesByHandle: entriesByHandle, offeredOps: offeredOps };
  }

  // ---------------------------------------------------------------------------
  // evaluateDecision (D-16, D-17, D-20, F22)
  // ---------------------------------------------------------------------------

  function escalate(reason, latch) {
    return { act: false, reason: reason, latch: latch || 'iteration' };
  }

  function acceptReason(verdict) {
    return isObject(verdict) && typeof verdict.reason === 'string' && contains(ACCEPT_REASONS, verdict.reason)
      ? verdict.reason
      : 'malformed';
  }

  function isAccepted(verdict) {
    return isObject(verdict) && verdict.accepted === true;
  }

  /** The handle an e-id maps to (own keys only), or null. */
  function handleFor(idMap, choice) {
    if (!isObject(idMap) || typeof choice !== 'string' || !hasOwn(idMap, choice)) return null;
    return typeof idMap[choice] === 'string' ? idMap[choice] : null;
  }

  /** The menu entry for a handle from a Map or a plain object, or null. */
  function entryFor(entriesByHandle, handle) {
    var found = null;
    if (entriesByHandle && typeof entriesByHandle.get === 'function' && typeof entriesByHandle.has === 'function') {
      found = entriesByHandle.has(handle) ? entriesByHandle.get(handle) : null;
    } else if (isObject(entriesByHandle) && hasOwn(entriesByHandle, handle)) {
      found = entriesByHandle[handle];
    }
    return isObject(found) ? found : null;
  }

  /**
   * Turn one decide() result into a fast step or a typed escalation.
   * ctx: {request, idMap, entriesByHandle, offeredOps}.
   *
   * Order: a fallback takes classifyFallback's latch; an operation answer
   * that is not calibrated or is malformed latches the session; an accepted
   * stuck flag escalates; completion must be accepted (Jev is confident the
   * task is not done yet) or not a fit (threshold_null), else the LLM decides
   * whether the task is done; then the operation must be accepted, offered and
   * a fast-mode op. A page op acts only when the target answer is not a
   * confident element pick. An element op needs an accepted target that maps
   * to a menu entry offering that op, with no risk reason, that is
   * fast-eligible. Every other escalation costs one iteration.
   *
   * @returns {{act:true, op:string, handle:(string|null), entry:(Object|null)}
   *   |{act:false, reason:string, latch:'session'|'command'|'iteration'}}
   */
  function evaluateDecision(result, ctx) {
    var c = isObject(ctx) ? ctx : {};
    if (!isObject(result) || result.ok !== true) {
      var verdict = classifyFallback(isObject(result) && result.ok === false ? result.fallback : undefined);
      return escalate(verdict.reason, verdict.latch);
    }
    var policy = resolvePolicy();
    if (!policy || typeof policy.accept !== 'function') return escalate('unavailable', 'session');

    var operation = policy.accept(result, 'operation');
    if (!isAccepted(operation)) {
      var operationReason = acceptReason(operation);
      if (operationReason === 'not_calibrated') return escalate('not_calibrated', 'session');
      if (operationReason === 'malformed') return escalate('operation_malformed', 'session');
    }
    if (isAccepted(policy.accept(result, 'stuck'))) return escalate('jev_stuck');
    var completion = policy.accept(result, 'completion');
    if (!isAccepted(completion) && acceptReason(completion) !== 'threshold_null') return escalate('completion_unconfirmed');
    if (!isAccepted(operation)) return escalate('operation_' + acceptReason(operation));

    var op = operation.choice;
    var offeredOps = Array.isArray(c.offeredOps) ? c.offeredOps : [];
    if (typeof op !== 'string' || !contains(OFFER_ORDER, op) || contains(NEVER_OFFERED, op) || !contains(offeredOps, op)) {
      return escalate('op_not_offered');
    }
    if (isObject(c.request) && Array.isArray(c.request.offeredOps) && !contains(c.request.offeredOps, op)) {
      return escalate('op_not_offered');
    }

    var target = policy.accept(result, 'target');
    var targetReason = isAccepted(target) ? null : acceptReason(target);
    if (contains(PAGE_OPS, op)) {
      if (isAccepted(target)) return escalate('page_op_with_target');
      if (contains(NO_ELEMENT_PICK, targetReason)) return { act: true, op: op, handle: null, entry: null };
      return escalate('target_' + targetReason, targetReason === 'malformed' ? 'session' : 'iteration');
    }
    if (!isAccepted(target)) return escalate('target_' + targetReason, targetReason === 'malformed' ? 'session' : 'iteration');

    var handle = handleFor(c.idMap, target.choice);
    var entry = handle === null ? null : entryFor(c.entriesByHandle, handle);
    if (entry === null) return escalate('unknown_target');
    if (!Array.isArray(entry.ops) || !contains(entry.ops, op)) return escalate('op_not_in_element_ops');
    if (entry.risk !== null) return escalate('risk_excluded');
    if (entry.fastEligible !== true) return escalate('not_fast_eligible');
    return { act: true, op: op, handle: handle, entry: entry };
  }

  // ---------------------------------------------------------------------------
  // buildStaticCall (D-15, F1, F2, AUTO-03)
  // ---------------------------------------------------------------------------

  /**
   * The tool call for an acting decision, built only from code-held values:
   * the menu entry's handle, role and label, the menu generation and
   * constants. click, hover and press_enter carry {jevHandle, jevGeneration,
   * expectedRole, expectedName, visual_reason}; check_box adds checked:true
   * (F2: a fast tick never unticks); scroll is {direction:'down',
   * visual_reason}; go_back is {visual_reason}. pagePath (the menu URL's
   * path) lives on the call object, never in args: only the meta-attempt
   * key reads it (68-06), and nothing sends it anywhere.
   * ctx: {generation, callId, pageUrl}. Returns null for anything else.
   * @returns {{id:string, name:string, args:Object, source:'jev', pagePath:string}|null}
   */
  function buildStaticCall(decision, ctx) {
    var c = isObject(ctx) ? ctx : {};
    if (!isObject(decision) || decision.act !== true) return null;
    if (typeof c.callId !== 'string' || c.callId.length === 0) return null;
    var op = decision.op;
    var args;
    if (typeof op === 'string' && contains(ELEMENT_OPS, op)) {
      var entry = decision.entry;
      if (typeof decision.handle !== 'string' || !HANDLE_RE.test(decision.handle) || !isObject(entry)) return null;
      if (entry.handle !== decision.handle || typeof entry.role !== 'string' || typeof entry.label !== 'string') return null;
      if (typeof c.generation !== 'string' || c.generation.length === 0) return null;
      args = {
        jevHandle: decision.handle,
        jevGeneration: c.generation,
        expectedRole: entry.role,
        expectedName: entry.label,
        visual_reason: constants.FAST_VISUAL_REASON
      };
      if (op === 'check_box') args.checked = true;
    } else if (op === 'scroll') {
      args = { direction: 'down', visual_reason: constants.FAST_VISUAL_REASON };
    } else if (op === 'go_back') {
      args = { visual_reason: constants.FAST_VISUAL_REASON };
    } else {
      return null;
    }
    return { id: c.callId, name: op, args: args, source: 'jev', pagePath: pagePathOf(c.pageUrl) };
  }

  var api = {
    constants: constants,
    classifyFallback: classifyFallback,
    toBuilderInput: toBuilderInput,
    evaluateDecision: evaluateDecision,
    buildStaticCall: buildStaticCall
  };
  root.FsbFastPath = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
