import Database from "better-sqlite3";
import {
  createInMemoryProjectionStore,
  createSqliteProjectionStore,
} from "../src/projection/index.js";
import { describeProjectionStoreContract } from "./contracts/projection-store-contract.js";

describeProjectionStoreContract("inmem", async () => ({
  store: createInMemoryProjectionStore(),
  close: async () => {},
}));

describeProjectionStoreContract("sqlite", async () => {
  const db = new Database(":memory:");
  return {
    store: createSqliteProjectionStore(db),
    close: async () => db.close(),
  };
});
