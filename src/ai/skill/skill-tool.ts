import type { MCPTool, MCPToolResult } from "../tool/types.js";
import { MCPToolResult as MCPToolResultFactory } from "../tool/types.js";
import type { SkillStore } from "./types.js";

/**
 * MCP tool for retrieving skill content from a SkillStore.
 *
 * This is the "Tier 2" delivery mechanism: the LLM sees skill summaries in the system prompt
 * and calls this tool to retrieve the full content of a specific skill on demand.
 */
export function createSkillTool(store: SkillStore): MCPTool {
  return {
    name: "get_skill",
    description:
      "Retrieve the full content of a skill by name. " +
      "Use this when you need detailed instructions from a skill listed in the available skills summary.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The skill name (as shown in the available skills list)",
        },
      },
      required: ["name"],
    },

    async execute(input: unknown): Promise<MCPToolResult> {
      const params = input as { name?: string };
      const skillName = params.name ?? "";

      if (!skillName) {
        return MCPToolResultFactory.failure("skill name is required");
      }

      const definition = await store.get(skillName);
      if (!definition) {
        return MCPToolResultFactory.failure(`Skill '${skillName}' not found`);
      }

      return MCPToolResultFactory.success({
        name: skillName,
        description: definition.description,
        whenToUse: definition.whenToUse,
        content: definition.content,
      });
    },
  };
}

/**
 * Build a system prompt section summarizing available skills.
 * The LLM can then call the get_skill tool for full content.
 */
export async function buildSkillSummary(store: SkillStore): Promise<string> {
  const skills = await store.list();
  if (skills.length === 0) return "";

  const lines = skills.map(([name, defn]) => {
    let line = `- **${name}**: ${defn.description}`;
    if (defn.whenToUse) line += ` (use when: ${defn.whenToUse})`;
    return line;
  });

  return `## Available Skills\n\nUse the \`get_skill\` tool to retrieve full instructions for any skill.\n\n${lines.join("\n")}`;
}
