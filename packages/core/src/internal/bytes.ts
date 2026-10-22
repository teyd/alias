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
