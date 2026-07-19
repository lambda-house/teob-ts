import type { SkillDefinition, SkillStore } from "./types.js";

/** In-memory skill store implementation. */
export function createInMemorySkillStore(): SkillStore & { add(name: string, definition: SkillDefinition): void } {
  const skills = new Map<string, SkillDefinition>();

  return {
    add(name: string, definition: SkillDefinition): void {
      skills.set(name, definition);
    },

    async list(): Promise<Array<[string, SkillDefinition]>> {
      return [...skills.entries()];
    },

    async get(name: string): Promise<SkillDefinition | undefined> {
      return skills.get(name);
    },
  };
}
