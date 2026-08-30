/**
 * Showcase application entry point.
 *
 * Start with: npx tsx showcase/server/main.ts
 */

import { buildService } from "../../src/service/service-template.js";
import { createLifecycleLogger } from "../../src/service/lifecycle.js";
import { showcaseTemplate } from "./service.js";

const service = await buildService(showcaseTemplate, createLifecycleLogger("Showcase"));

process.on("SIGINT", async () => {
  console.log("\n[showcase] Shutting down...");
  await service.shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await service.shutdown();
  process.exit(0);
});

console.log("[showcase] Server ready at http://localhost:" + (process.env.PORT ?? 3000));
