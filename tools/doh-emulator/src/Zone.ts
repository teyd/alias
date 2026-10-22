import * as Arr from "effect/Array";
import * as Num from "effect/Number";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import type * as Types from "effect/Types";
import * as Str from "effect/String";

/**
 * Authoritative data for the DoH emulator, and the JSON answers Cloudflare's resolver gives for
 * it. The format follows Cloudflare's documentation and what its resolver was recorded answering
 * (`packages/dns/fixtures`): owner names without the root's trailing dot, CNAME and MX targets
 * with it, TXT character-strings quoted and split at 255 characters, a followed CNAME first in
 * `Answer`, and the zone's SOA in `Authority` when nothing answers.
 *
 * It shares no code with the production client (`@alias/dns`), so the two check each other.
 */

export type RecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT";

/** One record. `data` in zone-file form: `10 mx.example.com` for MX, the bare text for TXT. */
export interface ZoneRecord {
  readonly name: string;
  readonly type: RecordType;
  readonly data: string;
  readonly ttl?: number;
}

/** Zones by apex, each with every record in it. Names outside every zone don't exist. */
export type Zones = Readonly<Record<string, ReadonlyArray<ZoneRecord>>>;

/** IANA RR type numbers (https://www.iana.org/assignments/dns-parameters). */
const TYPE_NUMBERS = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  CAA: 257,
} as const;

/** The number of a type given by name, in any letter case. */
const numberOf = (name: string): Option.Option<number> =>
  Option.map(
    Arr.findFirst(R.toEntries(TYPE_NUMBERS), ([type]) => type === Str.toUpperCase(name)),
    ([, value]) => value,
  );

const NOERROR = 0;
const NXDOMAIN = 3;
const DEFAULT_TTL = 300;
/** RFC 1035 §3.3: a character-string is at most 255 octets. */
const MAX_STRING = 255;

interface JsonRecord {
  readonly name: string;
  readonly type: number;
  readonly TTL: number;
  readonly data: string;
}

/** A DoH JSON answer as Cloudflare serves it. */
export interface JsonAnswer {
  readonly Status: number;
  readonly TC: boolean;
  readonly RD: boolean;
  readonly RA: boolean;
  readonly AD: boolean;
  readonly CD: boolean;
  readonly Question: ReadonlyArray<{ readonly name: string; readonly type: number }>;
  readonly Answer?: ReadonlyArray<JsonRecord>;
  readonly Authority?: ReadonlyArray<JsonRecord>;
}

/** A question, or Cloudflare's error message for a malformed one. */
export type Query = Result.Result<{ readonly name: string; readonly type: number }, string>;

const canonical = (name: string): string =>
  Str.toLowerCase(name.endsWith(".") ? name.slice(0, -1) : name);

const LABEL = /^[^.]{1,63}$/;

/** Reads `name` and `type` the way Cloudflare does, with its error messages. */
export const parseQuery = (params: URLSearchParams): Query => {
  const name = params.get("name");
  if (name === null || name === "") {
    return Result.fail("Query must have `name` parameter.");
  }
  const bare = name.endsWith(".") ? name.slice(0, -1) : name;
  const isValidName =
    bare.length <= 253 && (bare === "" || Arr.every(bare.split("."), (label) => LABEL.test(label)));
  if (!isValidName) return Result.fail(`Invalid query name \`${name}\`.`);
  const rawType = params.get("type") ?? "A";
  const typeNumber = /^\d+$/.test(rawType)
    ? Option.some(Number(rawType)).pipe(Option.filter((value) => value >= 1 && value <= 65_535))
    : numberOf(rawType);
  return Option.match(typeNumber, {
    onNone: () => Result.fail(`Invalid query type \`${rawType}\`.`),
    onSome: (type) => Result.succeed({ name: bare, type }),
  });
};

/** Quoted 255-character strings, as Cloudflare prints a TXT record. */
const quoteTxt = (text: string): string =>
  Arr.join(
    Arr.map(
      Arr.chunksOf(Array.from(text), MAX_STRING),
      (chunk) => `"${Arr.join(chunk, "").replace(/(["\\])/g, "\\$1")}"`,
    ),
    " ",
  );

const fqdn = (name: string) => (name.endsWith(".") ? name : `${name}.`);

const presentMx = (data: string): string => {
  const [preference = "0", exchange = "."] = data.trim().split(/\s+/);
  return `${preference} ${exchange === "." ? "." : fqdn(canonical(exchange))}`;
};

/** Record data as Cloudflare prints it, by type. */
const present: Readonly<Record<RecordType, (data: string) => string>> = {
  A: (data) => data,
  AAAA: (data) => data,
  CNAME: (data) => fqdn(canonical(data)),
  MX: presentMx,
  TXT: quoteTxt,
};

const toJson = (record: ZoneRecord, owner: string): JsonRecord => ({
  name: owner,
  type: TYPE_NUMBERS[record.type],
  TTL: record.ttl ?? DEFAULT_TTL,
  data: present[record.type](record.data),
});

const zoneOf = (zones: Zones, name: string): Option.Option<string> =>
  Arr.head(
    Arr.sort(
      Arr.filter(R.keys(zones), (apex) => name === apex || name.endsWith(`.${apex}`)),
      // The most specific zone wins.
      Order.mapInput(Num.Order, (apex: string) => -apex.length),
    ),
  );

const soa = (apex: string): JsonRecord => ({
  name: apex,
  type: TYPE_NUMBERS.SOA,
  TTL: DEFAULT_TTL,
  data: "ns.doh-emulator.invalid. hostmaster.doh-emulator.invalid. 1 10000 2400 604800 300",
});

interface Resolution {
  readonly status: number;
  readonly answer: ReadonlyArray<JsonRecord>;
  readonly authority: ReadonlyArray<JsonRecord>;
}

/** Follows CNAMEs within the zones, at most `hops` times (a loop ends there). */
const resolve = (zones: Zones, owner: string, type: number, hops: number): Resolution => {
  const name = canonical(owner);
  return Option.match(zoneOf(zones, name), {
    // The emulator knows no other zones: a name outside them doesn't exist.
    onNone: () => ({ status: NXDOMAIN, answer: [], authority: [] }),
    onSome: (apex) => {
      const inZone = zones[apex] ?? [];
      const atName = Arr.filter(inZone, (record) => canonical(record.name) === name);
      const alias = Arr.findFirst(atName, (record) => record.type === "CNAME");
      if (Option.isSome(alias) && type !== TYPE_NUMBERS.CNAME && hops > 0) {
        const followed = resolve(zones, canonical(alias.value.data), type, hops - 1);
        return { ...followed, answer: [toJson(alias.value, owner), ...followed.answer] };
      }
      const matching = Arr.filter(atName, (record) => TYPE_NUMBERS[record.type] === type);
      if (Arr.isReadonlyArrayNonEmpty(matching)) {
        return {
          status: NOERROR,
          answer: Arr.map(matching, (record) => toJson(record, owner)),
          authority: [],
        };
      }
      // A name with records, or above one (an empty non-terminal, RFC 8020), exists.
      const exists =
        name === apex ||
        Arr.some(inZone, (record) => {
          const recordName = canonical(record.name);
          return recordName === name || recordName.endsWith(`.${name}`);
        });
      return { status: exists ? NOERROR : NXDOMAIN, answer: [], authority: [soa(apex)] };
    },
  });
};

/** The JSON answer to one question. */
export const answer = (zones: Zones, name: string, type: number): JsonAnswer => {
  const resolved = resolve(zones, name, type, 8);
  const body: Types.Mutable<JsonAnswer> = {
    Status: resolved.status,
    TC: false,
    RD: true,
    RA: true,
    AD: false,
    CD: false,
    Question: [{ name, type }],
  };
  if (Arr.isReadonlyArrayNonEmpty(resolved.answer)) body.Answer = resolved.answer;
  if (Arr.isReadonlyArrayNonEmpty(resolved.authority)) body.Authority = resolved.authority;
  return body;
};
