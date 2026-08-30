// Renders the CLI templates into checked-in fixture files that are compiled
// against the real framework APIs (see ../cli-fixtures.test.ts). A template
// change must be accompanied by re-running this script:
//
//   pnpm exec tsx test/cli-fixtures/generate.ts

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  aggregateTemplate,
  projectionTemplate,
  flowTemplate,
  initTemplate,
} from "../../src/cli/templates.js";

export function renderFixtures(): Record<string, string> {
  return {
    "aggregate.fixture.ts": aggregateTemplate("gift-card"),
    "projection.fixture.ts": projectionTemplate("gift-card-summary"),
    "flow.fixture.ts": flowTemplate("order-fulfillment"),
    "service.fixture.ts": initTemplate().serviceTs,
  };
}

export const fixturesDir = dirname(fileURLToPath(import.meta.url));

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixtures = renderFixtures();
  for (const [name, content] of Object.entries(fixtures)) {
    writeFileSync(join(fixturesDir, name), content);
  }
  console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${fixturesDir}`);
}
