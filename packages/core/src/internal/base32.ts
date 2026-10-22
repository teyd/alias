import * as Arr from "effect/Array";
import * as Option from "effect/Option";

/**
 * RFC 4648 base32, lowercase and unpadded. Mail systems may change the case of a local part,
 * and `Address.parse` lowercases it, so the alphabet must be case-insensitive: base64 is not.
 */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

const groups = (bits: string, size: number): ReadonlyArray<string> =>
  bits.match(new RegExp(`.{1,${size}}`, "g")) ?? [];

export const encode = (bytes: Uint8Array): string =>
  Arr.map(
    groups(Arr.map(Array.from(bytes), (byte) => byte.toString(2).padStart(8, "0")).join(""), 5),
    (group) => ALPHABET.charAt(Number.parseInt(group.padEnd(5, "0"), 2)),
  ).join("");

/**
 * Decodes canonical base32 only: the unused trailing bits must be zero and there may be no
 * spare character. Otherwise several strings would decode to the same bytes, and a token
 * would have more than one valid spelling.
 */
export const decode = (text: string): Option.Option<Uint8Array> => {
  const indices = Arr.map(Array.from(text.toLowerCase()), (char) => ALPHABET.indexOf(char));
  if (Arr.some(indices, (index) => index === -1)) return Option.none();
  const bits = Arr.map(indices, (index) => index.toString(2).padStart(5, "0")).join("");
  const spare = bits.length % 8;
  if (spare >= 5 || /1/.test(bits.slice(bits.length - spare))) return Option.none();
  return Option.some(
    Uint8Array.from(groups(bits.slice(0, bits.length - spare), 8), (group) =>
      Number.parseInt(group, 2),
    ),
  );
};
