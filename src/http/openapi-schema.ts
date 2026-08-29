// openapi-schema.ts — Generate OpenAPI 3.1 spec from aggregate descriptions

import type { AggregateDescription } from "../core/describe.js";

/** Options for OpenAPI schema generation. */
export interface OpenApiOptions {
  title?: string;
  version?: string;
  description?: string;
  /** Base path prefix for all routes (e.g. "/api"). Defaults to "/api". */
  basePath?: string;
}

/**
 * Generate an OpenAPI 3.1 specification from aggregate descriptions.
 *
 * Uses codec manifests to enumerate command and reply variants.
 * Each command/reply tag becomes a schema with `tag` as a const discriminator.
 * Field-level schemas use `additionalProperties: true` since runtime type info
 * is limited to tag names.
 *
 * ```ts
 * const descriptions = [
 *   describeAggregate({ aggregate, eventCodec, stateCodec, commandCodec, replyCodec }),
 * ]
 * const spec = openApiSchema(descriptions)
 * ```
 */
export function openApiSchema(
  descriptions: AggregateDescription[],
  opts?: OpenApiOptions,
): Record<string, unknown> {
  const title = opts?.title ?? "TEOB API";
  const version = opts?.version ?? "1.0.0";
  const description = opts?.description ?? "Auto-generated from TEOB aggregate definitions";
  const basePath = opts?.basePath ?? "/api";

  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};

  for (const desc of descriptions) {
    const category = desc.category;
    const commandTags = desc.commands ?? [];
    const replyTags = desc.replies ?? [];

    // Build command schemas
    const commandSchemaRefs: unknown[] = [];
    for (const tag of commandTags) {
      const schemaName = `${pascalCase(category)}Command_${tag}`;
      schemas[schemaName] = {
        type: "object",
        required: ["tag"],
        properties: {
          tag: { type: "string", const: tag },
        },
        additionalProperties: true,
      };
      commandSchemaRefs.push({ $ref: `#/components/schemas/${schemaName}` });
    }

    // Build reply schemas
    const replySchemaRefs: unknown[] = [];
    for (const tag of replyTags) {
      const schemaName = `${pascalCase(category)}Reply_${tag}`;
      schemas[schemaName] = {
        type: "object",
        required: ["tag"],
        properties: {
          tag: { type: "string", const: tag },
        },
        additionalProperties: true,
      };
      replySchemaRefs.push({ $ref: `#/components/schemas/${schemaName}` });
    }

    // Union schemas
    const commandUnionName = `${pascalCase(category)}Command`;
    if (commandSchemaRefs.length > 0) {
      schemas[commandUnionName] = {
        oneOf: commandSchemaRefs,
        discriminator: {
          propertyName: "tag",
          mapping: Object.fromEntries(
            commandTags.map((tag) => [tag, `#/components/schemas/${pascalCase(category)}Command_${tag}`]),
          ),
        },
      };
    }

    const replyUnionName = `${pascalCase(category)}Reply`;
    if (replySchemaRefs.length > 0) {
      schemas[replyUnionName] = {
        oneOf: replySchemaRefs,
        discriminator: {
          propertyName: "tag",
          mapping: Object.fromEntries(
            replyTags.map((tag) => [tag, `#/components/schemas/${pascalCase(category)}Reply_${tag}`]),
          ),
        },
      };
    }

    // Path
    const path = `${basePath}/${category}/{entityId}`;
    const requestBody = commandSchemaRefs.length > 0
      ? {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${commandUnionName}` },
            },
          },
        }
      : undefined;

    const responses: Record<string, unknown> = {
      "200": {
        description: "Command processed successfully",
        headers: {
          ETag: {
            description: "Entity sequence number (for optimistic concurrency)",
            schema: { type: "string" },
          },
        },
        ...(replySchemaRefs.length > 0
          ? {
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/${replyUnionName}` },
                },
              },
            }
          : {}),
      },
      "400": {
        description: "Bad request or command rejected",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                error: { type: "string" },
                tag: { type: "string" },
              },
            },
          },
        },
      },
      "404": {
        description: "Category not found",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                error: { type: "string", const: "CategoryNotFound" },
                categoryId: { type: "string" },
              },
            },
          },
        },
      },
      "409": {
        description: "Conflict (ETag mismatch)",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                error: { type: "string", const: "Conflict" },
                expected: { type: "integer" },
                actual: { type: "integer" },
              },
            },
          },
        },
      },
      "504": {
        description: "Gateway timeout",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                error: { type: "string", const: "Timeout" },
              },
            },
          },
        },
      },
    };

    paths[path] = {
      post: {
        tags: [category],
        summary: `Send a command to a ${category} entity`,
        operationId: `${camelCase(category)}_command`,
        parameters: [
          {
            name: "entityId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Entity identifier",
          },
          {
            name: "If-Match",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "Expected entity version (sequence number) for optimistic concurrency",
          },
        ],
        ...(requestBody ? { requestBody } : {}),
        responses,
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: { title, version, description },
    paths,
    components: {
      schemas,
    },
  };
}

function pascalCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function camelCase(s: string): string {
  const pc = pascalCase(s);
  return pc.charAt(0).toLowerCase() + pc.slice(1);
}
