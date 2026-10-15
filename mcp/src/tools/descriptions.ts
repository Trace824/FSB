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
export const MCP_TOOL_DESCRIPTIONS: TextTable = Object.freeze({});

// Tool name -> parameter name -> short MCP parameter description. Per-tool
// entries win over MCP_COMMON_PARAM_DESCRIPTIONS.
export const MCP_PARAM_DESCRIPTIONS: Readonly<Record<string, TextTable>> = Object.freeze({});

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
