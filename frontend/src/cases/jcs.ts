// RFC 8785 JSON Canonicalization Scheme (JCS) + SHA-256: the single authority for snapshot_sha256 (plan §11:
// "snapshot_sha256 — Frontend only (TypeScript), RFC 8785"). Keys sorted by UTF-16 code units; numbers in
// ECMAScript shortest round-trip form (JSON.stringify), -0 → 0; non-finite numbers are rejected.

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("JCS: non-finite numbers are not representable");
      return JSON.stringify(value); // ES Number::toString; JSON.stringify(-0) === "0"
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort(); // default sort = UTF-16 code units
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`JCS: unsupported type ${typeof value}`);
  }
}

export async function sha256Hex(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const jcsSha256 = (value: unknown) => sha256Hex(canonicalize(value));
