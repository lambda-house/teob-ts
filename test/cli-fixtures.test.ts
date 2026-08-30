// Pins the CLI templates to checked-in fixture renders that are compiled
// against the real framework APIs — so a template can never again drift from
// the framework (the codegen equivalent of a contract test).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { renderFixtures, fixturesDir } from "./cli-fixtures/generate.js";

describe("CLI template fixtures", () => {
  const fixtures = renderFixtures();

  it("match the checked-in renders (re-run test/cli-fixtures/generate.ts after a template change)", () => {
    for (const [name, content] of Object.entries(fixtures)) {
      const path = join(fixturesDir, name);
      expect(existsSync(path), `missing fixture ${name}`).toBe(true);
      expect(readFileSync(path, "utf-8"), `stale fixture ${name}`).toBe(content);
    }
  });

  it("compile against the real framework APIs", () => {
    try {
      execFileSync("pnpm", ["exec", "tsc", "-p", join(fixturesDir, "tsconfig.json")], {
        cwd: join(fixturesDir, "../.."),
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(
        `generated code no longer compiles against the framework:\n${err.stdout ?? ""}${err.stderr ?? ""}`,
      );
    }
  }, 60_000);
});
