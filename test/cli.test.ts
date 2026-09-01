import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  pascalCase,
  camelCase,
  kebabCase,
  aggregateTemplate,
  projectionTemplate,
  flowTemplate,
  initTemplate,
} from "../src/cli/templates.js";

// --- Name conversion ---

describe("name conversion", () => {
  it("pascalCase from kebab", () => {
    expect(pascalCase("gift-card")).toBe("GiftCard");
  });

  it("pascalCase from single word", () => {
    expect(pascalCase("order")).toBe("Order");
  });

  it("pascalCase from snake_case", () => {
    expect(pascalCase("order_item")).toBe("OrderItem");
  });

  it("camelCase from kebab", () => {
    expect(camelCase("gift-card")).toBe("giftCard");
  });

  it("camelCase from single word", () => {
    expect(camelCase("order")).toBe("order");
  });

  it("kebabCase from PascalCase", () => {
    expect(kebabCase("GiftCard")).toBe("gift-card");
  });

  it("kebabCase from camelCase", () => {
    expect(kebabCase("giftCard")).toBe("gift-card");
  });

  it("kebabCase passthrough", () => {
    expect(kebabCase("gift-card")).toBe("gift-card");
  });
});

// --- Templates ---

describe("aggregateTemplate", () => {
  it("generates valid TypeScript with correct naming", () => {
    const output = aggregateTemplate("gift-card");
    expect(output).toContain("export type GiftCardCommand");
    expect(output).toContain("export type GiftCardEvent");
    expect(output).toContain("export interface GiftCardState");
    expect(output).toContain("export type GiftCardReply");
    expect(output).toContain("export const giftCardCategory");
    expect(output).toContain("export const giftCardAggregate");
    expect(output).toContain('CategoryId("gift-card")');
    expect(output).toContain("export const giftCardEventCodec");
    expect(output).toContain("export const giftCardStateCodec");
  });

  it("generates from single word", () => {
    const output = aggregateTemplate("order");
    expect(output).toContain("export type OrderCommand");
    expect(output).toContain("export const orderAggregate");
    expect(output).toContain('CategoryId("order")');
  });

  it("includes decide and apply functions", () => {
    const output = aggregateTemplate("order");
    expect(output).toContain("async decide(");
    expect(output).toContain("apply(state:");
    expect(output).toContain("initial(_id:");
  });
});

describe("projectionTemplate", () => {
  it("generates projection with correct naming", () => {
    const output = projectionTemplate("order-summary");
    expect(output).toContain("export interface OrderSummaryView");
    expect(output).toContain("export const orderSummaryProjection");
    expect(output).toContain('projectionId: "order-summary"');
  });
});

describe("flowTemplate", () => {
  it("generates flow scaffold with correct naming", () => {
    const output = flowTemplate("signup-flow");
    expect(output).toContain("export type SignupFlowPlace");
    expect(output).toContain("export const signupFlowCategory");
    expect(output).toContain('CategoryId("signup-flow")');
  });
});

describe("initTemplate", () => {
  it("returns service.ts with quickstart wiring", () => {
    const { serviceTs } = initTemplate();
    expect(serviceTs).toContain("quickstart");
    expect(serviceTs).toContain("aggregate");
    expect(serviceTs).toContain("port: 3000");
  });

  it("returns tsconfig.json with correct settings", () => {
    const { tsconfigJson } = initTemplate();
    const parsed = JSON.parse(tsconfigJson);
    expect(parsed.compilerOptions.target).toBe("ES2023");
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(parsed.compilerOptions.module).toBe("NodeNext");
  });

  it("returns package.json patch with dependencies", () => {
    const { packageJsonPatch } = initTemplate();
    expect(packageJsonPatch.type).toBe("module");
    expect((packageJsonPatch.dependencies as any)["@lambda-house/teob-ts"]).toBe("latest");
    expect((packageJsonPatch.scripts as any).dev).toContain("tsx");
  });
});

// --- CLI integration (file system) ---

describe("CLI file generation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "teob-cli-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("aggregateTemplate writes valid file content", () => {
    const content = aggregateTemplate("shopping-cart");
    const filePath = path.join(tmpDir, "shopping-cart.ts");
    fs.writeFileSync(filePath, content);

    const read = fs.readFileSync(filePath, "utf-8");
    expect(read).toContain("ShoppingCartCommand");
    expect(read).toContain("shoppingCartAggregate");
  });

  it("initTemplate files are writable", () => {
    const { serviceTs, tsconfigJson, packageJsonPatch } = initTemplate();

    fs.writeFileSync(path.join(tmpDir, "service.ts"), serviceTs);
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), tsconfigJson);
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(packageJsonPatch, null, 2));

    expect(fs.existsSync(path.join(tmpDir, "service.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "tsconfig.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "package.json"))).toBe(true);
  });
});
