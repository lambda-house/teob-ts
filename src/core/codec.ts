// Codec — JSON serialization with string manifests

export interface Codec<A> {
  manifest(value: A): string;
  encode(value: A): unknown; // JSON-serializable
  decode(manifest: string, data: unknown): A;
  /** Known manifest strings. Populated when tags are passed to tagCodec/objectCodec. */
  manifests?: readonly string[];
}

// Simple codec for discriminated unions with a "tag" field
// Pass all tag values for runtime discoverability: tagCodec<MyEvent>("Created", "Deleted")

export function tagCodec<A extends { tag: string }>(...tags: string[]): Codec<A> {
  return {
    manifest(value) {
      return value.tag;
    },
    encode(value) {
      return value;
    },
    decode(_manifest, data) {
      return data as A;
    },
    ...(tags.length > 0 ? { manifests: tags } : {}),
  };
}

// Event upcasting — structured schema evolution

/** A single upcast transformation: converts data from one manifest to another. */
export interface Upcast {
  sourceManifest: string;
  targetManifest: string;
  transform: (data: unknown) => unknown;
}

/**
 * Define an upcast from one event version to another.
 *
 * @param sourceManifest - The manifest string to match on (e.g. "OrderPlaced" or "OrderPlacedV1")
 * @param targetManifest - The manifest string after transformation (can be the same for in-place evolution)
 * @param transform - Function that converts old data shape to new data shape
 */
export function upcast(
  sourceManifest: string,
  targetManifest: string,
  transform: (data: unknown) => unknown,
): Upcast {
  return { sourceManifest, targetManifest, transform };
}

/**
 * Wrap a base codec with an upcast chain for schema evolution.
 *
 * During decode, if the manifest matches an upcast's sourceManifest, the transform
 * is applied and the manifest is updated to the targetManifest. Upcasts are applied
 * in sequence, allowing chained migrations (V1 → V2 → V3).
 *
 * Events are stored as-is (original version); upcasting happens on read.
 */
export function codecWithUpcasts<A>(base: Codec<A>, upcasts: Upcast[]): Codec<A> {
  return {
    manifest(value) {
      return base.manifest(value);
    },
    encode(value) {
      return base.encode(value);
    },
    decode(manifest: string, data: unknown): A {
      let currentManifest = manifest;
      let currentData = data;
      for (const u of upcasts) {
        if (currentManifest === u.sourceManifest) {
          currentData = u.transform(currentData);
          currentManifest = u.targetManifest;
        }
      }
      return base.decode(currentManifest, currentData);
    },
    ...(base.manifests ? { manifests: base.manifests } : {}),
  };
}

// Codec for plain objects (single manifest)

export function objectCodec<A>(manifestStr: string): Codec<A> {
  return {
    manifest() {
      return manifestStr;
    },
    encode(value) {
      return value;
    },
    decode(_manifest, data) {
      return data as A;
    },
    manifests: [manifestStr],
  };
}
