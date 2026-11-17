import { classifyOtherCapability } from "../analysis/gap-engine.js";

// BM-38 / N-AT-07 (knock-out Phase 5): read an agent's real tool list instead of typing the profile by hand.
// Supported inputs (pasted or uploaded text, never fetched from a URL):
//   - "mcp":     an MCP tools/list result ({ tools: [{ name, description }] }, { result: { tools } } or a bare array)
//   - "openapi": an OpenAPI / Swagger document in JSON (each operation: METHOD path + summary/operationId)
//   - "iam":     an AWS IAM policy in JSON (Allow statements' Action values; "s3:DeleteObject" -> "s3 delete object")
// Each item is matched with the engine's fixed keyword rules (classifyOtherCapability, no model). Items that map to a
// profile capability set that capability; items in the extra groups (money, production systems, people, publishing)
// become "other capability" lines; items that match nothing are listed for a person to review and are NOT added.
// Nothing is applied to a profile automatically: the result is a proposal plus a signed snapshot of what was read.

export type ImportFormat = "mcp" | "openapi" | "iam";
export const MAX_ITEMS = 2000;

const words = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_:/.{}-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

export function extractItems(format: ImportFormat, content: string): { items: string[]; notes: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    throw new Error(format === "openapi" ? "The OpenAPI file must be JSON (YAML is not supported here; convert it to JSON first)." : "The input is not valid JSON.");
  }
  const items: string[] = [];
  const notes: string[] = [];
  if (format === "mcp") {
    const tools = Array.isArray(doc) ? doc : ((doc as { tools?: unknown })?.tools ?? (doc as { result?: { tools?: unknown } })?.result?.tools);
    if (!Array.isArray(tools)) throw new Error("No MCP tool list found: expected { tools: [...] }, { result: { tools: [...] } } or an array of tools.");
    for (const tool of tools) {
      const t = tool as { name?: unknown; description?: unknown };
      if (typeof t?.name !== "string") { notes.push("A tool without a name was skipped."); continue; }
      items.push(`${t.name}: ${typeof t.description === "string" ? t.description : ""}`.trim());
    }
  } else if (format === "openapi") {
    const paths = (doc as { paths?: Record<string, Record<string, unknown>> })?.paths;
    if (!paths || typeof paths !== "object") throw new Error("No 'paths' found: this does not look like an OpenAPI document.");
    for (const [path, ops] of Object.entries(paths)) {
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const op = (ops as Record<string, unknown>)?.[method] as { summary?: unknown; operationId?: unknown; description?: unknown } | undefined;
        if (!op) continue;
        const label = [op.summary, op.operationId, op.description].find((v) => typeof v === "string") as string | undefined;
        items.push(`${method.toUpperCase()} ${path}: ${words(label ?? "")} ${method === "delete" ? "deletes data" : ""}`.trim());
      }
    }
  } else {
    const statements = Array.isArray(doc) ? doc : (doc as { Statement?: unknown })?.Statement;
    const list = Array.isArray(statements) ? statements : statements ? [statements] : [];
    if (!list.length) throw new Error("No IAM Statement found.");
    for (const st of list) {
      const s = st as { Effect?: unknown; Action?: unknown; NotAction?: unknown };
      if (s.Effect !== "Allow") continue;
      if (s.NotAction !== undefined) notes.push("A statement uses NotAction (allows everything except a list): review it by hand; it is not expanded here.");
      const actions = Array.isArray(s.Action) ? s.Action : s.Action !== undefined ? [s.Action] : [];
      for (const a of actions) {
        if (typeof a !== "string") continue;
        if (a === "*" || /:\*$/.test(a)) notes.push(`"${a}" grants every action${a === "*" ? "" : " of that service"}: treat it as full administrative access.`);
        items.push(`${a}: ${words(a)}${/(^\*$|:\*$)/.test(a) ? " administrator access" : ""}`);
      }
    }
  }
  if (items.length > MAX_ITEMS) throw new Error(`Too many items (${items.length}); the limit is ${MAX_ITEMS}.`);
  return { items, notes };
}

export function proposeProfile(items: string[]) {
  const capabilities: Record<string, true> = {};
  const otherCapabilities: string[] = [];
  const matches: Array<{ item: string; rules: string[] }> = [];
  const unmatched: string[] = [];
  for (const item of items) {
    const rules = classifyOtherCapability(item);
    if (!rules.length) { unmatched.push(item); continue; }
    matches.push({ item, rules: rules.map((r) => r.key) });
    for (const rule of rules) {
      if (rule.covers) capabilities[String(rule.covers)] = true;
      else if (otherCapabilities.length < 20) otherCapabilities.push(item.slice(0, 300));
    }
  }
  return { capabilities, otherCapabilities: [...new Set(otherCapabilities)], matches, unmatched };
}
