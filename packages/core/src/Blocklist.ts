import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { isDomain } from "./Address.ts";

/**
 * A user's blocklist across all of their aliases (PLAN.md §20.32): sender addresses and sender
 * domains whose mail is dropped and counted as blocked, whichever alias it was sent to.
 *
 * Each entry is one lowercase string, which is also its id: `news@shop.example` (that address),
 * `shop.example` (that domain only) or `*.shop.example` (the domain and every subdomain). The
 * forward path checks a sender against the whole set with at most one lookup per label of the
 * sender's domain, so the cost doesn't grow with the list.
 */

/** Entries per user. The set lives in one table item that every message reads (PLAN.md §20.32). */
export const MAX_ENTRIES = 500;

/** RFC 5321 §4.5.3.1.3: an address is at most 254 octets. */
const MAX_ADDRESS_LENGTH = 254;

const SUBDOMAINS = "*.";

const Kind = Schema.Literals(["address", "domain"]);

/** One entry as the API shows it. `id` is the stored string. */
export const Entry = Schema.Struct({
  id: Schema.String,
  kind: Kind,
  /** The address or the domain, lowercase. */
  value: Schema.String,
  /** For a domain: its subdomains are blocked too. Always false for an address. */
  isSubdomainIncluded: Schema.Boolean,
});
export type Entry = typeof Entry.Type;

/** What a user asks to block. */
export const NewEntry = Schema.Struct({
  kind: Kind,
  value: Schema.String,
  isSubdomainIncluded: Schema.optionalKey(Schema.Boolean),
});
export type NewEntry = typeof NewEntry.Type;

export type Refusal = "invalid-address" | "invalid-domain";

const isAddress = (value: string) => {
  const at = value.lastIndexOf("@");
  return (
    at > 0 &&
    value.length <= MAX_ADDRESS_LENGTH &&
    !/[\s<>()",;\p{Cc}]/u.test(value) &&
    isDomain(value.slice(at + 1))
  );
};

/** The stored string for what the user asked to block, or why it can't be one. */
export const normalize = (entry: NewEntry): Result.Result<string, Refusal> => {
  const value = Str.toLowerCase(Str.trim(entry.value));
  if (entry.kind === "address") {
    return isAddress(value) ? Result.succeed(value) : Result.fail("invalid-address");
  }
  const domain = value.startsWith(SUBDOMAINS) ? value.slice(SUBDOMAINS.length) : value;
  if (!isDomain(domain)) return Result.fail("invalid-domain");
  return Result.succeed(
    entry.isSubdomainIncluded === true || value.startsWith(SUBDOMAINS)
      ? `${SUBDOMAINS}${domain}`
      : domain,
  );
};

/** A stored string as an entry. */
export const entry = (id: string): Entry => {
  if (id.includes("@")) return { id, kind: "address", value: id, isSubdomainIncluded: false };
  return id.startsWith(SUBDOMAINS)
    ? { id, kind: "domain", value: id.slice(SUBDOMAINS.length), isSubdomainIncluded: true }
    : { id, kind: "domain", value: id, isSubdomainIncluded: false };
};

/**
 * The entries a sender address would hit: the address itself, its domain, and the domain and
 * each parent domain with subdomains included (`a.b.example` → `*.a.b.example`, `*.b.example`,
 * `*.example`).
 */
const candidates = (sender: string): ReadonlyArray<string> => {
  const address = Str.toLowerCase(Str.trim(sender));
  const at = address.lastIndexOf("@");
  if (at <= 0) return [address];
  const labels = address.slice(at + 1).split(".");
  const parents = Arr.map(Arr.range(0, labels.length - 1), (start) =>
    Arr.join(labels.slice(start), "."),
  );
  return [address, address.slice(at + 1), ...Arr.map(parents, (parent) => SUBDOMAINS + parent)];
};

/** The entry that blocks mail from `sender`, if any: the most specific one. */
export const match = (entries: HashSet.HashSet<string>, sender: string): Option.Option<string> =>
  Arr.findFirst(candidates(sender), (candidate) => HashSet.has(entries, candidate));
