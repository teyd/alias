import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Num from "effect/Number";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { type DnsUnavailable, type Mx, Resolver } from "./Doh.ts";

/**
 * The DNS records a custom domain needs (PLAN.md §3.1, §18, §20.18) and how each is checked. SES
 * runs in eu-west-1 only, so the endpoints are fixed.
 *
 * - **Ownership** (TXT on the domain, a random token per claim): proves that whoever added the
 *   domain controls its DNS. The DKIM CNAMEs prove it to SES, but their tokens belong to the SES
 *   identity, not to the user who claimed the domain, and the MX is the same for every SES
 *   customer in the region, so neither proves it to us.
 * - **Receiving** (MX on the domain → SES inbound).
 * - **DKIM** (three Easy DKIM CNAMEs): SES verifies the identity and signs with them.
 * - **MAIL FROM** (MX and SPF on `bounce.<domain>`): bounces go there, and SPF aligns with the
 *   domain. Recommended; without it SES sends with its own MAIL FROM domain.
 * - **DMARC** (TXT on `_dmarc.<domain>`): recommended, any policy (PLAN.md §19.3).
 */

export const inboundHost = "inbound-smtp.eu-west-1.amazonaws.com";
export const feedbackHost = "feedback-smtp.eu-west-1.amazonses.com";
/** Where Easy DKIM CNAMEs point when SES names no `SigningHostedZone`. */
export const defaultDkimZone = "dkim.amazonses.com";
const VERIFICATION_PREFIX = "alias-verification=";

/** The custom MAIL FROM domain: a subdomain used for nothing else, as SES requires. */
export const mailFromDomain = (domain: string): string => `bounce.${domain}`;

export interface Setup {
  readonly domain: string;
  /** The random token of this claim, published as `alias-verification=<token>`. */
  readonly verificationToken: string;
  /** Easy DKIM tokens from SES (three). */
  readonly dkimTokens: ReadonlyArray<string>;
  /** SES's `SigningHostedZone`, else {@link defaultDkimZone}. */
  readonly dkimZone: string;
}

export const Purpose = Schema.Literals(["ownership", "receiving", "dkim", "mail-from", "dmarc"]);
export type Purpose = typeof Purpose.Type;

export const RecordType = Schema.Literals(["TXT", "MX", "CNAME"]);
export type RecordType = typeof RecordType.Type;

/** One record to publish. `value` is what to enter; for MX, `priority` goes in its own field. */
export const DnsRecord = Schema.Struct({
  purpose: Purpose,
  /** Needed before the domain is verified; the rest are recommended. */
  isRequired: Schema.Boolean,
  type: RecordType,
  name: Schema.String,
  value: Schema.String,
  priority: Schema.optionalKey(Schema.Int),
});
export type DnsRecord = typeof DnsRecord.Type;

/** `unknown`: the resolver couldn't answer, which says nothing about the record. */
export const CheckState = Schema.Literals(["ok", "missing", "wrong", "unknown"]);
export type CheckState = typeof CheckState.Type;

export const Check = Schema.Struct({ record: DnsRecord, state: CheckState });
export type Check = typeof Check.Type;

const spf = "v=spf1 include:amazonses.com ~all";

export const records = (setup: Setup): ReadonlyArray<DnsRecord> => {
  const mailFrom = mailFromDomain(setup.domain);
  return [
    {
      purpose: "ownership",
      isRequired: true,
      type: "TXT",
      name: setup.domain,
      value: `${VERIFICATION_PREFIX}${setup.verificationToken}`,
    },
    {
      purpose: "receiving",
      isRequired: true,
      type: "MX",
      name: setup.domain,
      value: inboundHost,
      priority: 10,
    },
    ...Arr.map(setup.dkimTokens, (token): DnsRecord => ({
      purpose: "dkim",
      isRequired: true,
      type: "CNAME",
      name: `${token}._domainkey.${setup.domain}`,
      value: `${token}.${setup.dkimZone}`,
    })),
    {
      purpose: "mail-from",
      isRequired: false,
      type: "MX",
      name: mailFrom,
      value: feedbackHost,
      priority: 10,
    },
    { purpose: "mail-from", isRequired: false, type: "TXT", name: mailFrom, value: spf },
    {
      purpose: "dmarc",
      isRequired: false,
      type: "TXT",
      name: `_dmarc.${setup.domain}`,
      value: "v=DMARC1; p=none",
    },
  ];
};

const isSpf = (text: string) => Str.toLowerCase(text).startsWith("v=spf1 ") || text === "v=spf1";

const present = (isOk: boolean, found: ReadonlyArray<unknown>): CheckState =>
  isOk ? "ok" : Arr.isReadonlyArrayEmpty(found) ? "missing" : "wrong";

/** Mail goes to the most preferred exchanges, so all of them must be SES's. */
const isReceivingMx = (found: ReadonlyArray<Mx>) =>
  Arr.match(found, {
    onEmpty: () => false,
    onNonEmpty: (all) => {
      const lowest = Arr.min(
        Arr.map(all, (mx) => mx.preference),
        Num.Order,
      );
      return Arr.every(
        Arr.filter(all, (mx) => mx.preference === lowest),
        (mx) => mx.exchange === inboundHost,
      );
    },
  });

/** How the published records compare with what one record needs. Pure, for each record type. */
export const judge = {
  ownership: (record: DnsRecord, found: ReadonlyArray<string>): CheckState =>
    Arr.some(found, (text) => text.trim() === record.value)
      ? "ok"
      : // Other TXT records on the domain (SPF, other services) are normal: only ours counts.
        "missing",
  receiving: (found: ReadonlyArray<Mx>): CheckState => present(isReceivingMx(found), found),
  dkim: (record: DnsRecord, found: ReadonlyArray<string>): CheckState =>
    present(Arr.contains(found, Str.toLowerCase(record.value)), found),
  /** SES needs exactly one MX on the MAIL FROM domain. */
  mailFromMx: (found: ReadonlyArray<Mx>): CheckState =>
    present(found.length === 1 && Arr.every(found, (mx) => mx.exchange === feedbackHost), found),
  /** One SPF record (two are a permanent error, RFC 7208 §4.5) that includes SES. */
  mailFromSpf: (found: ReadonlyArray<string>): CheckState => {
    const policies = Arr.filter(found, isSpf);
    return present(
      policies.length === 1 &&
        Arr.some(policies, (policy) =>
          Arr.contains(Str.split(Str.toLowerCase(policy), /\s+/), "include:amazonses.com"),
        ),
      policies,
    );
  },
  dmarc: (found: ReadonlyArray<string>): CheckState =>
    Arr.some(found, (text) => Str.toLowerCase(text).replace(/\s/g, "").startsWith("v=dmarc1"))
      ? "ok"
      : "missing",
};

const settle = <A>(
  lookup: Effect.Effect<A, DnsUnavailable>,
  decide: (found: A) => CheckState,
): Effect.Effect<CheckState> =>
  lookup.pipe(
    Effect.map(decide),
    Effect.catchTag("DnsUnavailable", () => Effect.succeed<CheckState>("unknown")),
  );

/** Looks every record up now. Resolver failures become `unknown`, never `missing`. */
export const check = Effect.fn("DomainSetup.check")(function* (setup: Setup) {
  const resolver = yield* Resolver;
  const lookup: Record<Purpose, (record: DnsRecord) => Effect.Effect<CheckState>> = {
    ownership: (record) =>
      settle(resolver.txt(record.name), (found) => judge.ownership(record, found)),
    receiving: (record) => settle(resolver.mx(record.name), judge.receiving),
    dkim: (record) => settle(resolver.cname(record.name), (found) => judge.dkim(record, found)),
    "mail-from": (record) =>
      record.type === "MX"
        ? settle(resolver.mx(record.name), judge.mailFromMx)
        : settle(resolver.txt(record.name), judge.mailFromSpf),
    dmarc: (record) => settle(resolver.txt(record.name), judge.dmarc),
  };
  return yield* Effect.forEach(
    records(setup),
    (record) => Effect.map(lookup[record.purpose](record), (state): Check => ({ record, state })),
    { concurrency: 4 },
  );
});

/** What the published records say about the domain as a whole. */
export type Verdict = "ready" | "not-ready" | "inconclusive";

/**
 * `ready` when every required record is `ok`; `inconclusive` when one couldn't be looked up and
 * nothing required is known to be wrong or missing; else `not-ready`.
 */
export const verdict = (checks: ReadonlyArray<Check>): Verdict => {
  const required = Arr.filter(checks, (found) => found.record.isRequired);
  if (Arr.some(required, (found) => found.state === "missing" || found.state === "wrong")) {
    return "not-ready";
  }
  return Arr.every(required, (found) => found.state === "ok") ? "ready" : "inconclusive";
};
