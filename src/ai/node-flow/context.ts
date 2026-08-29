import { readPath } from "./guard.js";

/**
 * Render a `{{var}}` template against a context map. Variables not present
 * are replaced with the empty string. Path tokens (`{{a.b}}`) are read via
 * the same JSON-path subset used by `Guard`.
 */
export function renderTemplate(template: string, context: unknown): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, expr: string) => {
    const value = readPath(expr.trim(), context);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  });
}

/**
 * Apply a response/output mapping `{ contextKey: jsonPath }` to a payload,
 * producing a record `{ contextKey: extractedValue }`. Mappings whose paths
 * don't resolve are silently skipped.
 */
export function applyMapping(
  mapping: Record<string, string>,
  payload: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(mapping)) {
    const v = readPath(path, payload);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Apply `inputMapping` `{ paramName: contextPath }` to context, producing
 * `{ paramName: contextValue }` suitable for invoking a tool/HTTP body.
 */
export function applyInputMapping(
  mapping: Record<string, string>,
  context: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [param, path] of Object.entries(mapping)) {
    const v = readPath(path, context);
    if (v !== undefined) out[param] = v;
  }
  return out;
}
