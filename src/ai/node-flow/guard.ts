export type Guard =
  | { type: "always" }
  | { type: "eq"; path: string; value: unknown }
  | { type: "neq"; path: string; value: unknown }
  | { type: "gt"; path: string; value: number }
  | { type: "gte"; path: string; value: number }
  | { type: "lt"; path: string; value: number }
  | { type: "lte"; path: string; value: number }
  | { type: "contains"; path: string; value: string }
  | { type: "and"; left: Guard; right: Guard }
  | { type: "or"; left: Guard; right: Guard }
  | { type: "not"; inner: Guard };

/**
 * Read a JSON-path-style accessor against a context object.
 * Supports `$.a.b[0].c` and bare `a.b.c`. Returns `undefined` for misses.
 */
export function readPath(path: string, ctx: unknown): unknown {
  if (!path) return ctx;
  const trimmed = path.startsWith("$.") ? path.slice(2) : path.startsWith("$") ? path.slice(1) : path;
  if (trimmed === "") return ctx;
  // Tokenize on dots and bracket indices.
  const tokens: Array<string | number> = [];
  let i = 0;
  let buf = "";
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === ".") {
      if (buf) {
        tokens.push(buf);
        buf = "";
      }
      i += 1;
    } else if (ch === "[") {
      if (buf) {
        tokens.push(buf);
        buf = "";
      }
      const close = trimmed.indexOf("]", i);
      if (close < 0) return undefined;
      const inner = trimmed.slice(i + 1, close);
      const num = Number(inner);
      tokens.push(Number.isFinite(num) ? num : inner.replace(/^['"]|['"]$/g, ""));
      i = close + 1;
    } else {
      buf += ch;
      i += 1;
    }
  }
  if (buf) tokens.push(buf);

  let cur: unknown = ctx;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof t === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[t];
    }
  }
  return cur;
}

export function evaluate(g: Guard, context: unknown): boolean {
  switch (g.type) {
    case "always":
      return true;
    case "eq":
      return readPath(g.path, context) === g.value;
    case "neq":
      return readPath(g.path, context) !== g.value;
    case "gt": {
      const v = readPath(g.path, context);
      return typeof v === "number" && v > g.value;
    }
    case "gte": {
      const v = readPath(g.path, context);
      return typeof v === "number" && v >= g.value;
    }
    case "lt": {
      const v = readPath(g.path, context);
      return typeof v === "number" && v < g.value;
    }
    case "lte": {
      const v = readPath(g.path, context);
      return typeof v === "number" && v <= g.value;
    }
    case "contains": {
      const v = readPath(g.path, context);
      if (typeof v === "string") return v.includes(g.value);
      if (Array.isArray(v)) return v.includes(g.value);
      return false;
    }
    case "and":
      return evaluate(g.left, context) && evaluate(g.right, context);
    case "or":
      return evaluate(g.left, context) || evaluate(g.right, context);
    case "not":
      return !evaluate(g.inner, context);
  }
}
