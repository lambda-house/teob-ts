import type { FileInfo, FileStore } from "./file-store.js";
import { extname } from "node:path";

/** In-memory file store for testing. */
export function createInMemoryFileStore(): FileStore {
  const files = new Map<string, string>();

  function matchGlob(path: string, pattern: string): boolean {
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*\*/g, "(.+)").replace(/\*/g, "([^/]+)") + "$",
    );
    return regex.test(path);
  }

  return {
    async read(path: string): Promise<string> {
      const content = files.get(path);
      if (content === undefined) throw new Error(`File not found: ${path}`);
      return content;
    },

    async write(path: string, content: string): Promise<number> {
      files.set(path, content);
      return new TextEncoder().encode(content).length;
    },

    async list(directory: string, glob?: string): Promise<string[]> {
      const prefix = directory.endsWith("/") ? directory : directory + "/";
      let paths = [...files.keys()].filter((p) => p.startsWith(prefix));
      if (glob) {
        paths = paths.filter((p) => matchGlob(p, glob));
      }
      return paths;
    },

    async info(path: string): Promise<FileInfo | undefined> {
      const content = files.get(path);
      if (content === undefined) return undefined;
      return {
        path,
        size: new TextEncoder().encode(content).length,
        isDirectory: false,
        extension: extname(path),
      };
    },

    async exists(path: string): Promise<boolean> {
      return files.has(path);
    },
  };
}
