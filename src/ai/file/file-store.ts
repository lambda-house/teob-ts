/** Configuration for file store safety limits. */
export interface FileToolConfig {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxListEntries: number;
  allowedExtensions?: string[];
  denyPatterns?: RegExp[];
}

export const defaultFileToolConfig: FileToolConfig = {
  maxReadBytes: 1_000_000,
  maxWriteBytes: 1_000_000,
  maxListEntries: 1000,
};

/** File metadata. */
export interface FileInfo {
  path: string;
  size: number;
  isDirectory: boolean;
  extension: string;
  modifiedAt?: Date;
}

/** Abstract file store interface. */
export interface FileStore {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<number>;
  list(directory: string, glob?: string): Promise<string[]>;
  info(path: string): Promise<FileInfo | undefined>;
  exists(path: string): Promise<boolean>;
}
