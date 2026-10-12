import { describe, expect, it } from "vitest";
import vectors from "./fixtures/jcs_vectors.json";
import { canonicalize, jcsSha256 } from "./jcs";

describe("RFC 8785 canonicalization (snapshot_sha256 authority)", () => {
  it(`matches the reference implementation on ${vectors.length} vectors`, async () => {
    expect(vectors.length).toBeGreaterThanOrEqual(50);
    for (const v of vectors) {
      expect(canonicalize(v.input)).toBe(v.canonical);
      expect(await jcsSha256(v.input)).toBe(v.sha256);
    }
  });

  it("drops undefined members, normalizes -0 and rejects non-finite numbers", () => {
    expect(canonicalize({ b: undefined, a: -0 })).toBe('{"a":0}');
    expect(() => canonicalize({ x: Number.NaN })).toThrow();
    expect(() => canonicalize({ x: Infinity })).toThrow();
  });
});
