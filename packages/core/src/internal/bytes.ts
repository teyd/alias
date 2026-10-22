import * as Arr from "effect/Array";

const encoder = new TextEncoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);

export const isEmptyBytes = (bytes: Uint8Array): boolean => bytes.byteLength === 0;

export const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(Arr.reduce(parts, 0, (length, part) => length + part.length));
  Arr.reduce(parts, 0, (offset, part) => {
    out.set(part, offset);
    return offset + part.length;
  });
  return out;
};

/**
 * Compares two byte strings in time that depends only on their length, so a forger learns
 * nothing from how fast a wrong MAC is rejected.
 */
export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && Arr.reduce(a, 0, (diff, byte, i) => diff | (byte ^ (b[i] ?? 0))) === 0;

const CHUNK = 8192;

/**
 * One char per byte (U+0000–U+00FF), so byte strings can be searched and rewritten with string
 * tools and turned back into exactly the same bytes by {@link fromBinary}. Unlike
 * `TextDecoder("latin1")`, which is windows-1252, it maps 0x80–0x9F to themselves.
 */
export const toBinary = (bytes: Uint8Array): string =>
  Arr.map(Arr.range(0, Math.ceil(bytes.length / CHUNK) - 1), (chunk) =>
    String.fromCharCode(...bytes.subarray(chunk * CHUNK, (chunk + 1) * CHUNK)),
  ).join("");

export const fromBinary = (text: string): Uint8Array =>
  Uint8Array.from(text, (char) => char.charCodeAt(0));
