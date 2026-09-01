/** A section within a versioned prompt. */
export interface VersionedPromptSection {
  tag: string;
  content: string;
  priority: number;
}

/** A specific version of a prompt. */
export interface PromptVersion {
  promptId: string;
  versionId: string;
  parentVersionId: string | undefined;
  sections: VersionedPromptSection[];
  separator: string;
  metadata: Record<string, string>;
  createdAt: Date;
}

/** Registry for versioned prompts with template substitution. */
export interface PromptRegistry {
  /** Create a new prompt with its first version. */
  create(
    promptId: string,
    sections: VersionedPromptSection[],
    metadata?: Record<string, string>,
    separator?: string,
  ): Promise<PromptVersion>;

  /** Create a new version of an existing prompt, linked to the current version. */
  update(
    promptId: string,
    sections: VersionedPromptSection[],
    metadata?: Record<string, string>,
  ): Promise<PromptVersion>;

  /** Get the latest version of a prompt. */
  get(promptId: string): Promise<PromptVersion | undefined>;

  /** Get a specific version of a prompt. */
  getVersion(promptId: string, versionId: string): Promise<PromptVersion | undefined>;

  /** List all versions of a prompt (newest first). */
  listVersions(promptId: string): Promise<PromptVersion[]>;

  /**
   * Resolve a prompt: render with {{variable}} template substitution.
   * Returns the rendered string and the version ID used.
   */
  resolve(
    promptId: string,
    context?: Record<string, string>,
  ): Promise<{ rendered: string; versionId: string } | undefined>;
}
