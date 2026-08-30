import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { resolve, extname, relative } from "node:path";
import type { FileInfo, FileStore, FileToolConfig } from "./file-store.js";
import { defaultFileToolConfig } from "./file-store.js";

/**
 * Filesystem-backed file store with path jail and safety limits.
 * All paths are resolved relative to rootDir; traversal outside is blocked.
 */
export function createLocalFileStore(
  rootDir: string,
  config: FileToolConfig = defaultFileToolConfig,
): FileStore {
  function safePath(path: string): string {
    const resolved = resolve(rootDir, path);
    const rel = relative(rootDir, resolved);
    if (rel.startsWith("..") || resolve(rootDir, rel) !== resolved) {
      throw new Error(`Path traversal blocked: ${path}`);
    }
    if (config.denyPatterns?.some((p) => p.test(resolved))) {
      throw new Error(`Path denied by policy: ${path}`);
    }
    if (config.allowedExtensions) {
      const ext = extname(resolved);
      if (ext && !config.allowedExtensions.includes(ext)) {
        throw new Error(`Extension not allowed: ${ext}`);
      }
    }
    return resolved;
  }

  return {
    async read(path: string): Promise<string> {
      const fullPath = safePath(path);
      const content = await readFile(fullPath, "utf-8");
      if (new TextEncoder().encode(content).length > config.maxReadBytes) {
        throw new Error(`File exceeds max read size of ${config.maxReadBytes} bytes`);
      }
      return content;
    },

    async write(path: string, content: string): Promise<number> {
      const fullPath = safePath(path);
      const bytes = new TextEncoder().encode(content).length;
      if (bytes > config.maxWriteBytes) {
        throw new Error(`Content exceeds max write size of ${config.maxWriteBytes} bytes`);
      }
      await writeFile(fullPath, content, "utf-8");
      return bytes;
    },

    async list(directory: string, glob?: string): Promise<string[]> {
      const fullPath = safePath(directory);
      const entries = await readdir(fullPath, { recursive: true });
      let paths = entries.map((e) => String(e));
      if (glob) {
        const regex = new RegExp(
          "^" + glob.replace(/\./g, "\\.").replace(/\*\*/g, "(.+)").replace(/\*/g, "([^/]+)") + "$",
        );
        paths = paths.filter((p) => regex.test(p));
      }
      return paths.slice(0, config.maxListEntries);
    },

    async info(path: string): Promise<FileInfo | undefined> {
      try {
        const fullPath = safePath(path);
        const st = await stat(fullPath);
        return {
          path,
          size: st.size,
          isDirectory: st.isDirectory(),
          extension: extname(fullPath),
          modifiedAt: st.mtime,
        };
      } catch {
        return undefined;
      }
    },

    async exists(path: string): Promise<boolean> {
      try {
        const fullPath = safePath(path);
        await stat(fullPath);
        return true;
      } catch {
        return false;
      }
    },
  };
}
