import type { SkillDefinition } from "./types.js";

export interface ParsedSkill {
  name: string;
  definition: SkillDefinition;
}

/**
 * Parses SKILL.md files with YAML frontmatter into SkillDefinition.
 *
 * Follows the Anthropic Claude Code skill format:
 * ```
 * ---
 * name: objection-price
 * description: "Techniques for handling price objections"
 * when-to-use: "When customer raises price concerns"
 * allowed-tools: [knowledge_search]
 * arguments: [objection_type]
 * version: "1.0"
 * ---
 *
 * ## Markdown body here...
 * ```
 */
export function parseSkillMarkdown(fileName: string, content: string): ParsedSkill {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    throw new Error(`Missing frontmatter delimiter in ${fileName}`);
  }

  const afterFirst = trimmed.slice(3);
  const endIdx = afterFirst.indexOf("\n---");
  if (endIdx < 0) {
    throw new Error(`Missing closing frontmatter delimiter in ${fileName}`);
  }

  const frontmatterStr = afterFirst.substring(0, endIdx);
  const body = afterFirst.substring(endIdx + 4).trim();

  const fields = parseFrontmatter(frontmatterStr);
  const name = fields.name ?? fileNameToSkillId(fileName);

  const definition: SkillDefinition = {
    description: fields.description ?? "",
    whenToUse: fields["when-to-use"] ?? fields.when_to_use,
    allowedTools: parseListField(fields["allowed-tools"] ?? fields.allowed_tools),
    arguments: parseListField(fields.arguments),
    version: fields.version,
    content: body,
  };

  return { name, definition };
}

/** Parse only the SkillDefinition without extensions. */
export function parseSkillDefinition(fileName: string, content: string): [string, SkillDefinition] {
  const parsed = parseSkillMarkdown(fileName, content);
  return [parsed.name, parsed.definition];
}

/** Parse simple YAML frontmatter into key-value pairs. */
function parseFrontmatter(raw: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;

    const key = trimmed.substring(0, colonIdx).trim();
    let value = trimmed.substring(colonIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/** Parse a YAML inline list `[a, b, c]` or a single value into a list of strings. */
function parseListField(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
          return s.slice(1, -1);
        }
        return s;
      });
  }

  return trimmed.split(/\s+/).filter(Boolean);
}

/** Convert a file name like "objection-price.skill.md" to skill ID "objection-price". */
function fileNameToSkillId(fileName: string): string {
  return fileName
    .replace(/\.md$/, "")
    .replace(/\.skill$/, "")
    .replace(/\/SKILL$/, "");
}
