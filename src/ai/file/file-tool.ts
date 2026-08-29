import type { MCPTool, MCPToolResult } from "../tool/types.js";
import { MCPToolResult as MCPToolResultFactory } from "../tool/types.js";
import type { FileStore } from "./file-store.js";

/**
 * MCP tool for file operations and text transformations.
 * Supports: read, write, list, info, parse_csv, parse_json, to_csv, markdown_to_html.
 */
export function createFileTool(store: FileStore): MCPTool {
  return {
    name: "file_ops",
    description:
      "Read, write, and list files. Also supports CSV/JSON parsing and conversion.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "write", "list", "info", "parse_csv", "parse_json", "to_csv", "markdown_to_html"],
          description: "The file operation to perform",
        },
        path: { type: "string", description: "File or directory path" },
        content: { type: "string", description: "Content for write/parse operations" },
        glob: { type: "string", description: "Glob pattern for list filtering" },
        delimiter: { type: "string", description: "CSV delimiter (default: comma)" },
      },
      required: ["action"],
    },

    async execute(input: unknown): Promise<MCPToolResult> {
      const params = input as {
        action: string;
        path?: string;
        content?: string;
        glob?: string;
        delimiter?: string;
      };

      try {
        switch (params.action) {
          case "read": {
            if (!params.path) return MCPToolResultFactory.failure("path is required");
            const content = await store.read(params.path);
            return MCPToolResultFactory.success({ content, size: content.length });
          }

          case "write": {
            if (!params.path) return MCPToolResultFactory.failure("path is required");
            if (params.content === undefined) return MCPToolResultFactory.failure("content is required");
            const bytes = await store.write(params.path, params.content);
            return MCPToolResultFactory.success({ bytesWritten: bytes });
          }

          case "list": {
            if (!params.path) return MCPToolResultFactory.failure("path is required");
            const files = await store.list(params.path, params.glob);
            return MCPToolResultFactory.success(files);
          }

          case "info": {
            if (!params.path) return MCPToolResultFactory.failure("path is required");
            const info = await store.info(params.path);
            return info
              ? MCPToolResultFactory.success(info)
              : MCPToolResultFactory.failure(`File not found: ${params.path}`);
          }

          case "parse_csv": {
            const csv = params.content ?? (params.path ? await store.read(params.path) : undefined);
            if (!csv) return MCPToolResultFactory.failure("content or path is required");
            const rows = parseCsv(csv, params.delimiter ?? ",");
            return MCPToolResultFactory.success(rows);
          }

          case "parse_json": {
            const json = params.content ?? (params.path ? await store.read(params.path) : undefined);
            if (!json) return MCPToolResultFactory.failure("content or path is required");
            return MCPToolResultFactory.success(JSON.parse(json));
          }

          case "to_csv": {
            if (!params.content) return MCPToolResultFactory.failure("content (JSON array) is required");
            const data = JSON.parse(params.content) as Record<string, unknown>[];
            const csv = toCsv(data, params.delimiter ?? ",");
            return MCPToolResultFactory.success({ csv });
          }

          case "markdown_to_html": {
            const md = params.content ?? (params.path ? await store.read(params.path) : undefined);
            if (!md) return MCPToolResultFactory.failure("content or path is required");
            const html = markdownToHtml(md);
            return MCPToolResultFactory.success({ html });
          }

          default:
            return MCPToolResultFactory.failure(`Unknown action: ${params.action}`);
        }
      } catch (err) {
        return MCPToolResultFactory.failure(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** Simple CSV parser with quoted field support. */
function parseCsv(csv: string, delimiter: string): Record<string, string>[] {
  const lines = csv.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0], delimiter);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line, delimiter);
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = values[i] ?? "";
    }
    return row;
  });
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function toCsv(data: Record<string, unknown>[], delimiter: string): string {
  if (data.length === 0) return "";
  const headers = Object.keys(data[0]);
  const headerLine = headers.join(delimiter);
  const rows = data.map((row) =>
    headers.map((h) => {
      const val = String(row[h] ?? "");
      return val.includes(delimiter) || val.includes('"') || val.includes("\n")
        ? `"${val.replace(/"/g, '""')}"`
        : val;
    }).join(delimiter),
  );
  return [headerLine, ...rows].join("\n");
}

/** Minimal markdown to HTML conversion. */
function markdownToHtml(md: string): string {
  return md
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^/, "<p>")
    .replace(/$/, "</p>");
}
