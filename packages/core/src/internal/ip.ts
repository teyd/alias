import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

/** The 4 bytes of a dotted-quad IPv4 address (no leading `+`, no octal or hex forms). */
export const ipv4 = (text: string): Option.Option<ReadonlyArray<number>> => {
  const parts = text.split(".");
  if (parts.length !== 4 || !Arr.every(parts, (part) => /^\d{1,3}$/.test(part))) {
    return Option.none();
  }
  const bytes = Arr.map(parts, Number);
  return Arr.every(bytes, (byte) => byte <= 255) ? Option.some(bytes) : Option.none();
};

/** The 16 bytes of an IPv6 address (`::` compression and an embedded IPv4 tail allowed). */
export const ipv6 = (text: string): Option.Option<ReadonlyArray<number>> => {
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  const hasIpv4Tail = Str.includes(".")(tail);
  const embedded = hasIpv4Tail ? ipv4(tail) : Option.some<ReadonlyArray<number>>([]);
  if (Option.isNone(embedded)) return Option.none();
  // An IPv4 tail stands for the last two groups.
  const asGroups = Arr.map(Arr.chunksOf(embedded.value, 2), ([high, low]) =>
    (high * 256 + (low ?? 0)).toString(16),
  );
  const hex = hasIpv4Tail ? `${text.slice(0, lastColon + 1)}${Arr.join(asGroups, ":")}` : text;
  const groupsOf = (part: string) => (Str.isEmpty(part) ? [] : part.split(":"));
  const halves = hex.split("::");
  if (halves.length > 2) return Option.none();
  const left = groupsOf(halves[0] ?? "");
  const right = groupsOf(halves[1] ?? "");
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return Option.none();
  // `Arr.replicate` returns at least one element, so the no-`::` case adds none by hand.
  const filler = halves.length === 1 ? [] : Arr.replicate("0", missing);
  const groups = [...left, ...filler, ...right];
  if (!Arr.every(groups, (group) => /^[0-9a-f]{1,4}$/i.test(group))) return Option.none();
  return Option.some(
    Arr.flatMap(groups, (group) => {
      const value = Number.parseInt(group, 16);
      return [value >> 8, value & 0xff];
    }),
  );
};

/** Whether the first `bits` bits of `bytes` equal those of `prefix` (missing bytes count as 0). */
export const within = (bytes: ReadonlyArray<number>, prefix: ReadonlyArray<number>, bits: number) =>
  Arr.every(Arr.range(0, bits - 1), (bit) => {
    const mask = 0x80 >> (bit % 8);
    return (
      ((bytes[Math.floor(bit / 8)] ?? 0) & mask) === ((prefix[Math.floor(bit / 8)] ?? 0) & mask)
    );
  });

/** `::ffff:a.b.c.d`: an IPv4 address carried in IPv6 (dual-stack sockets report these). */
export const MAPPED_V4: ReadonlyArray<number> = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
