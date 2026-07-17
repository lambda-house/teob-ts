/**
 * Generic skill definition — follows the Anthropic SKILL.md frontmatter standard.
 *
 * @param description what this skill does
 * @param whenToUse when the LLM should invoke this skill
 * @param allowedTools tool names this skill may use
 * @param arguments named arguments the skill accepts
 * @param version skill version string
 * @param content the markdown body (instructions)
 */
export interface SkillDefinition {
  description: string;
  whenToUse?: string;
  allowedTools?: string[];
  arguments?: string[];
  version?: string;
  content: string;
}

/** Generic skill store — abstract retrieval of skills by name. */
export interface SkillStore {
  list(): Promise<Array<[string, SkillDefinition]>>;
  get(name: string): Promise<SkillDefinition | undefined>;
}
