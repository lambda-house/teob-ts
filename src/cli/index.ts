#!/usr/bin/env node

// teob CLI — scaffold aggregates, projections, flows, and projects

import * as fs from "node:fs";
import * as path from "node:path";
import {
  aggregateTemplate,
  projectionTemplate,
  flowTemplate,
  initTemplate,
  kebabCase,
} from "./templates.js";

function writeFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(filePath)) {
    console.error(`  File already exists: ${filePath}`);
    process.exit(1);
  }

  fs.writeFileSync(filePath, content);
  console.log(`  Created ${filePath}`);
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`  Created ${dirPath}/`);
  }
}

function handleNew(type: string, name: string): void {
  const kebab = kebabCase(name);

  switch (type) {
    case "aggregate": {
      const filePath = path.join(process.cwd(), "src", "aggregates", `${kebab}.ts`);
      writeFile(filePath, aggregateTemplate(name));
      break;
    }
    case "projection": {
      const filePath = path.join(process.cwd(), "src", "projections", `${kebab}.ts`);
      writeFile(filePath, projectionTemplate(name));
      break;
    }
    case "flow": {
      const filePath = path.join(process.cwd(), "src", "flows", `${kebab}.ts`);
      writeFile(filePath, flowTemplate(name));
      break;
    }
    default:
      console.error(`Unknown type: ${type}. Use: aggregate, projection, flow`);
      process.exit(1);
  }
}

function handleInit(): void {
  const cwd = process.cwd();
  const { serviceTs, tsconfigJson, packageJsonPatch } = initTemplate();

  ensureDir(path.join(cwd, "src", "aggregates"));
  ensureDir(path.join(cwd, "src", "projections"));
  ensureDir(path.join(cwd, "src", "flows"));

  writeFile(path.join(cwd, "src", "service.ts"), serviceTs);

  if (!fs.existsSync(path.join(cwd, "tsconfig.json"))) {
    writeFile(path.join(cwd, "tsconfig.json"), tsconfigJson);
  }

  // Merge into package.json if it exists, else create
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    const existing = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const merged = {
      ...existing,
      type: packageJsonPatch.type,
      scripts: { ...existing.scripts, ...(packageJsonPatch.scripts as object) },
      dependencies: { ...existing.dependencies, ...(packageJsonPatch.dependencies as object) },
      devDependencies: { ...existing.devDependencies, ...(packageJsonPatch.devDependencies as object) },
    };
    fs.writeFileSync(pkgPath, JSON.stringify(merged, null, 2) + "\n");
    console.log(`  Updated ${pkgPath}`);
  } else {
    writeFile(pkgPath, JSON.stringify(packageJsonPatch, null, 2) + "\n");
  }

  console.log("\nProject initialized. Next steps:");
  console.log("  npm install");
  console.log("  npx tsx src/service.ts");
}

function printUsage(): void {
  console.log(`
Usage:
  teob new aggregate <name>     Generate an aggregate scaffold
  teob new projection <name>    Generate a projection scaffold
  teob new flow <name>          Generate a Petri net flow scaffold
  teob init                     Initialize a new TEOB project

Examples:
  teob new aggregate order
  teob new projection order-summary
  teob init
`);
}

// Main
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  printUsage();
  process.exit(0);
}

const command = args[0];

switch (command) {
  case "new": {
    if (args.length < 3) {
      console.error("Usage: teob new <type> <name>");
      process.exit(1);
    }
    handleNew(args[1], args[2]);
    break;
  }
  case "init": {
    handleInit();
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
