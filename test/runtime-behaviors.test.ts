import { rmSync } from "node:fs";
import { createInMemoryRuntime } from "../src/inmem/runtime.js";
import { createInMemoryJournal } from "../src/inmem/journal.js";
import { createSqliteRuntime } from "../src/sqlite/index.js";
import type { SqliteJournal } from "../src/sqlite/journal.js";
import type { EntityRuntime } from "../src/core/runtime.js";
import {
  describeRuntimeBehaviors,
  counterRegistration,
  type RuntimeHarness,
} from "./contracts/runtime-behaviors.js";

describeRuntimeBehaviors("inmem", async (snapshotEvery): Promise<RuntimeHarness> => {
  const journal = createInMemoryJournal();
  let current = createInMemoryRuntime([counterRegistration(snapshotEvery)], { journal }).runtime;
  return {
    get runtime() {
      return current;
    },
    async restart() {
      await current.shutdown();
      current = createInMemoryRuntime([counterRegistration(snapshotEvery)], { journal }).runtime;
      return current;
    },
    async close() {
      await current.shutdown();
    },
  };
});

describeRuntimeBehaviors("sqlite", async (snapshotEvery): Promise<RuntimeHarness> => {
  const path = `/tmp/teob-rb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.db`;
  let handle: { runtime: EntityRuntime; journal: SqliteJournal } = createSqliteRuntime({ path }, [
    counterRegistration(snapshotEvery),
  ]);
  return {
    get runtime() {
      return handle.runtime;
    },
    async restart() {
      await handle.runtime.shutdown();
      handle.journal.close();
      handle = createSqliteRuntime({ path }, [counterRegistration(snapshotEvery)]);
      return handle.runtime;
    },
    async close() {
      await handle.runtime.shutdown();
      handle.journal.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    },
  };
});
