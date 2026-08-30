import type { PromptRegistry, PromptVersion, VersionedPromptSection } from "./types.js";

/**
 * In-memory prompt registry implementation.
 *
 * Supports version lineage, template variable substitution, and section priority ordering.
 */
export function createInMemoryPromptRegistry(): PromptRegistry {
  // promptId -> versions (newest first)
  const store = new Map<string, PromptVersion[]>();
  let versionCounter = 0;

  function nextVersionId(): string {
    return `v${++versionCounter}`;
  }

  function renderSections(
    sections: VersionedPromptSection[],
    separator: string,
    context: Record<string, string>,
  ): string {
    const sorted = [...sections].sort((a, b) => a.priority - b.priority);
    return sorted
      .map((s) => substituteVariables(s.content, context))
      .join(separator);
  }

  function substituteVariables(template: string, context: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => context[key] ?? match);
  }

  return {
    async create(promptId, sections, metadata = {}, separator = "\n\n") {
      const version: PromptVersion = {
        promptId,
        versionId: nextVersionId(),
        parentVersionId: undefined,
        sections,
        separator,
        metadata,
        createdAt: new Date(),
      };
      store.set(promptId, [version]);
      return version;
    },

    async update(promptId, sections, metadata = {}) {
      const versions = store.get(promptId);
      if (!versions || versions.length === 0) {
        throw new Error(`Prompt '${promptId}' not found`);
      }

      const current = versions[0];
      const version: PromptVersion = {
        promptId,
        versionId: nextVersionId(),
        parentVersionId: current.versionId,
        sections,
        separator: current.separator,
        metadata,
        createdAt: new Date(),
      };
      versions.unshift(version);
      return version;
    },

    async get(promptId) {
      const versions = store.get(promptId);
      return versions?.[0];
    },

    async getVersion(promptId, versionId) {
      const versions = store.get(promptId);
      return versions?.find((v) => v.versionId === versionId);
    },

    async listVersions(promptId) {
      return store.get(promptId) ?? [];
    },

    async resolve(promptId, context = {}) {
      const versions = store.get(promptId);
      const version = versions?.[0];
      if (!version) return undefined;

      const rendered = renderSections(version.sections, version.separator, context);
      return { rendered, versionId: version.versionId };
    },
  };
}
