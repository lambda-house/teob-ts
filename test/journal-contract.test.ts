import { createInMemoryJournal } from "../src/inmem/journal.js";
import { createSqliteJournal } from "../src/sqlite/journal.js";
import { describeJournalContract, syncJournalHarness } from "./contracts/journal-contract.js";

describeJournalContract("inmem", async () => syncJournalHarness(createInMemoryJournal()));

describeJournalContract("sqlite", async () => {
  const journal = createSqliteJournal({ path: ":memory:" });
  return syncJournalHarness(journal, () => journal.close());
});
