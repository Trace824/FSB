/**
 * MCP-only tool text (Phase 69 D-07).
 *
 * The shared registry (extension/ai/tool-definitions.js, copied to
 * mcp/ai/tool-definitions.cjs at build time) stays the autopilot source and
 * is never edited for MCP wording. The short text below is applied at MCP
 * registration instead, so only `.describe()` text changes on the MCP wire:
 * names, types, required lists, defaults and enums are untouched, and the
 * autopilot prompt is unchanged with Jev off.
 *
 * Writing rules (Phase 69 D-09 / D-10):
 * - the first sentence of a tool description carries its search terms;
 * - the multi-agent / TAB_NOT_OWNED rule is written once, in the common
 *   tab_id text, never per tool;
 * - the client text names common labels and says how matching works; it
 *   never points at a source file;
 * - the change-report suffix is one sentence that says to inspect the page
 *   before retrying.
 *
 * The lookups never throw: a missing entry falls back to the registry text so
 * the server still starts. Coverage is enforced by
 * tests/mcp-description-budget.test.js instead.
 */

type TextTable = Readonly<Record<string, string>>;

// Common parameter text, shared by every tool that publishes the parameter.
export const MCP_COMMON_PARAM_DESCRIPTIONS: TextTable = Object.freeze({
  tab_id: "Optional target tab; omit if this agent owns one tab. Another agent's tab is rejected (TAB_NOT_OWNED).",
  visual_reason: 'Short reason shown in the overlay.',
  client: 'Client label such as Claude, Codex, Cursor, ChatGPT, Gemini, VS Code, Copilot or Windsurf; case, spaces, _ and - are ignored.',
  is_final: 'True clears the overlay after this call.',
});

// Appended (after one space) to the description of every action tool whose
// registry entry has _emitChangeReport === true.
export const MCP_CHANGE_REPORT_SENTENCE =
  'Returns change_report (what changed); if the outcome is unknown, inspect the page before retrying.';

// The description of the optional `expect` parameter (published by plan 69-06).
export const MCP_EXPECT_DESCRIPTION =
  'Optional same-call check after the action; expect_result reports verified, unmet or uncertain. If unmet or uncertain, inspect the page before retrying.';

// Tool name -> short MCP description.
export const MCP_TOOL_DESCRIPTIONS: TextTable = Object.freeze({
  // --- registry action tools (registerManualTools, Phase 69 plan 02) ---
  execute_js: 'Execute JavaScript in the page as a function body; use return to send a value back (stringified; Promises are not awaited, so poll a window key for async work). Try it first for DOM reads, clicks and scrolls: it avoids overlay, viewport and CDP timeout issues. Verify a JS click with read_page. Fall back to native tools when a JS click changes nothing (click), for typing into controlled inputs (type_text), for real drags (drag_drop or drag), and for submits that need validated input (click the submit button).',
  navigate: 'Navigate the tab to a URL; returns the final URL after redirects.',
  search: 'Search the current site with its own search box, found automatically; falls back to Google when the site has none. Read results with read_page.',
  go_back: 'Go back one page in browser history; returns the new URL.',
  go_forward: 'Go forward one page in browser history; returns the new URL.',
  refresh: 'Refresh (reload) the current page; returns its URL.',
  click: 'Click an element by CSS selector, element ref (e5) from get_dom_snapshot, or visible text. Custom (non-native) dropdowns take two clicks: open the control, then click the option; select_option is for native <select> only. For canvas or overlay targets, use click_at.',
  type_text: 'Type text into an editable field by selector or ref. Replaces existing text by default (clear_first false appends); in Google Docs it inserts at the cursor unless clear_first is true. Returns the rendered text.',
  press_enter: 'Press Enter to submit a form or confirm input; falls back to clicking the submit button if Enter has no effect.',
  press_key: 'Press a keyboard key, optionally with ctrl, shift or alt, for shortcuts and special keys such as Escape, Tab or ArrowDown.',
  select_option: 'Select an option in a native <select> dropdown by value or visible text. Native <select> only: for custom (div-based) dropdowns use two clicks, first on the control and then on the option. If no error is returned but the value does not change, it is a custom dropdown.',
  check_box: 'Check or uncheck (toggle) a checkbox or switch; returns the new checked state. For custom checkbox widgets, use click.',
  hover: 'Hover the mouse over an element to reveal menus, tooltips or other hover content before clicking.',
  right_click: 'Right-click an element to open its context menu.',
  double_click: 'Double-click an element, for example to select a word or enter edit mode.',
  select_text_range: 'Select text inside an element by character offsets (startOffset to endOffset, end exclusive); returns the selected text. To select a whole word, use double_click.',
  drag_drop: 'Drag and drop one DOM element onto another by selector or ref, for Kanban cards and sortable lists. Tries HTML5 drag events, then pointer, then mouse events, and returns which worked. For canvas or coordinate drags, use drag.',
  drop_file: 'Drop a synthetic text file (name, content, MIME type) onto a dropzone element. For real files on disk, use upload_file; to move DOM elements, use drag_drop.',
  focus: 'Focus an element to prepare it for keyboard input.',
  clear_input: 'Clear the contents of an input field.',
  scroll: 'Scroll the page up or down by pixels (default one viewport); returns the new position.',
  scroll_to_top: 'Scroll to the top of the page.',
  scroll_to_bottom: 'Scroll to the bottom of the page, for example to load lazy content.',
  scroll_to_element: 'Scroll an element into view; returns its position.',
  open_tab: 'Open a URL in a new tab; returns the tab ID. The tab opens in the background unless active is true.',
  switch_tab: 'Switch to a tab this agent owns, by tab ID from list_tabs. The foreground tab does not change unless active is true.',
  close_tab: 'Close a tab this agent owns without changing the foreground tab. It refuses to close the active tab unless allow_active is true; set that only when the user asks to close the active tab.',
  fill_sheet: 'Fill Google Sheets cells with CSV data, starting at a given cell. Open the sheet first; large fills can take minutes.',
  click_at: 'Click at viewport coordinates (CSS pixels) with trusted CDP events, optionally with shift, ctrl or alt. Use it for canvas, SVG or overlay targets when click fails.',
  click_and_hold: 'Click and hold at viewport coordinates for holdMs, for record buttons or long-press menus.',
  drag: 'Drag between two viewport coordinates with trusted CDP mouse events, for canvas drawing, sliders and maps. For DOM elements use drag_drop; for slider CAPTCHAs use drag_variable_speed.',
  drag_variable_speed: 'Drag between two viewport coordinates with a human-like slow-fast-slow speed curve, for slider and puzzle CAPTCHAs. For uniform drags, use drag.',
  scroll_at: 'Scroll the mouse wheel at viewport coordinates, for map or canvas zoom. Negative deltaY zooms in or scrolls up; each call sends one tick.',
  insert_text: 'Insert text with CDP at the caret (default), at the end, or replacing an editable field (position replace_all). Canvas editors need focus first.',
  double_click_at: 'Double-click at viewport coordinates with trusted CDP events, for example to edit a canvas text box or a Sheets cell.',
  set_attribute: 'Set an HTML attribute on an element, for example a hidden field value, an ARIA state or a data attribute.',
  upload_file: 'Upload a real file from an absolute local path to an <input type=file>, or a dropzone wrapping one, through CDP. Secret paths such as ~/.ssh, ~/.aws, .env, private keys and the FSB vault are blocked, and uploads are audit-logged. For dropzones with no file input, use drop_file.',
});

// Tool name -> parameter name -> short MCP parameter description. Per-tool
// entries win over MCP_COMMON_PARAM_DESCRIPTIONS. Short registry text that
// needs no change is not repeated here.
export const MCP_PARAM_DESCRIPTIONS: Readonly<Record<string, TextTable>> = Object.freeze({
  execute_js: Object.freeze({
    code: 'JavaScript function body; use return to send a value back.',
  }),
  click: Object.freeze({
    selector: 'CSS selector or element ref (e5) from get_dom_snapshot.',
    text: 'Visible text to click instead of a selector; first visible case-insensitive match.',
  }),
  type_text: Object.freeze({
    selector: 'CSS selector or element ref of the field.',
    clear_first: 'Replace existing text; default true, but false in Google Docs (inserts at the cursor). False appends.',
  }),
  select_option: Object.freeze({
    selector: 'CSS selector or element ref of the <select>.',
    value: 'Option value or visible text.',
  }),
  select_text_range: Object.freeze({
    selector: 'CSS selector or element ref of the container.',
    startOffset: "Start offset in the element's text (0-based).",
    endOffset: 'End offset (exclusive).',
  }),
  drag_drop: Object.freeze({
    sourceSelector: 'Selector or ref of the element to drag.',
    targetSelector: 'Selector or ref of the drop target.',
    steps: 'Intermediate moves (default 10).',
    holdMs: 'Hold before moving, in ms (default 150).',
  }),
  drop_file: Object.freeze({
    selector: 'CSS selector of the dropzone.',
    fileName: 'File name, such as photo.jpg.',
    mimeType: 'MIME type, such as text/plain or image/png.',
  }),
  open_tab: Object.freeze({
    active: 'True foregrounds the new tab (steals focus); default false opens it in the background.',
  }),
  switch_tab: Object.freeze({
    active: 'True foregrounds the tab; default false leaves focus unchanged.',
  }),
  close_tab: Object.freeze({
    tab_id: 'Tab to close; omit if this agent owns one tab.',
    allow_active: 'True allows closing the active foreground tab (default false).',
  }),
  click_and_hold: Object.freeze({
    holdMs: 'Hold time in ms (default 5000).',
  }),
  drag: Object.freeze({
    steps: 'Intermediate moves (default 10; more is smoother).',
    stepDelayMs: 'Delay between moves in ms (default 20).',
    shift: 'Hold Shift (constrained movement).',
  }),
  drag_variable_speed: Object.freeze({
    startX: 'Start X in viewport CSS pixels (slider thumb).',
    startY: 'Start Y in viewport CSS pixels.',
    endX: 'End X in viewport CSS pixels (target gap).',
    endY: 'End Y in viewport CSS pixels (often startY).',
    steps: 'Intermediate moves (default 20; more is smoother).',
    minDelayMs: 'Shortest delay between moves in ms, at peak speed (default 5).',
    maxDelayMs: 'Longest delay between moves in ms, at the ends (default 40).',
  }),
  insert_text: Object.freeze({
    text: 'Text to insert.',
  }),
  upload_file: Object.freeze({
    selector: 'CSS selector of the <input type=file>, or of a dropzone that wraps a hidden one.',
    file_path: 'Absolute path of the file on disk; relative and ~ paths are rejected.',
  }),
});

function ownText(table: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  if (!table || !Object.prototype.hasOwnProperty.call(table, key)) return undefined;
  const value = table[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function hasMcpToolDescription(name: string): boolean {
  return ownText(MCP_TOOL_DESCRIPTIONS, name) !== undefined;
}

// Module text for the tool, otherwise the fallback (normally the registry
// text), otherwise ''.
export function mcpToolDescription(name: string, fallback?: string): string {
  return ownText(MCP_TOOL_DESCRIPTIONS, name) ?? fallback ?? '';
}

// A fresh map of the common parameter text merged with the tool's own
// parameter text (per-tool wins). Suitable as jsonSchemaToZod's override map.
export function mcpParamDescriptions(toolName: string): Readonly<Record<string, string>> {
  const merged: Record<string, string> = { ...MCP_COMMON_PARAM_DESCRIPTIONS };
  const own = Object.prototype.hasOwnProperty.call(MCP_PARAM_DESCRIPTIONS, toolName)
    ? MCP_PARAM_DESCRIPTIONS[toolName]
    : undefined;
  if (own) {
    for (const [param, text] of Object.entries(own)) {
      if (typeof text === 'string' && text.length > 0) merged[param] = text;
    }
  }
  return merged;
}

// Per-tool text, else common text, else the fallback, else ''.
export function mcpParamDescription(toolName: string, param: string, fallback?: string): string {
  const own = Object.prototype.hasOwnProperty.call(MCP_PARAM_DESCRIPTIONS, toolName)
    ? MCP_PARAM_DESCRIPTIONS[toolName]
    : undefined;
  return ownText(own, param) ?? ownText(MCP_COMMON_PARAM_DESCRIPTIONS, param) ?? fallback ?? '';
}
