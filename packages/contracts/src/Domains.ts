import { DomainSetup } from "@alias/dns";
import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Authentication } from "./Auth.ts";
import { requires } from "./Scopes.ts";

/** One DNS record to publish, and what the last check found (`unchecked` before the first). */
const DomainRecord = Schema.Struct({
  ...DomainSetup.DnsRecord.fields,
  state: Schema.Union([DomainSetup.CheckState, Schema.Literal("unchecked")]),
});

/**
 * A custom domain (PLAN.md §20.18). `pending` until every required record is published and SES
 * verified DKIM; aliases work only while it is `verified`; `failed` when a required record went
 * missing after that (it recovers by itself once the record is back).
 */
const Domain = Schema.Struct({
  domain: Schema.String,
  status: Schema.Literals(["pending", "verified", "failed"]),
  /** Mail to any address on the domain creates the alias. Off until the owner turns it on. */
  isCatchAllEnabled: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
  verifiedAt: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
  checkedAt: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
  /** A pending domain is released if it isn't verified by then. */
  expiresAt: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
  records: Schema.Array(DomainRecord),
});
export type Domain = typeof Domain.Type;

export class InvalidDomain extends Schema.TaggedError<InvalidDomain>()(
  "InvalidDomain",
  {
    domain: Schema.String,
    /** `shared-domain`: one of the service's own domains, or a subdomain of one. */
    reason: Schema.Literals(["invalid", "shared-domain"]),
  },
  { httpApiStatus: 400 },
) {}

/** Someone, perhaps the caller, already added this domain. */
export class DomainTaken extends Schema.TaggedError<DomainTaken>()(
  "DomainTaken",
  { domain: Schema.String },
  { httpApiStatus: 409 },
) {}

export class TooManyDomains extends Schema.TaggedError<TooManyDomains>()(
  "TooManyDomains",
  { limit: Schema.Number },
  { httpApiStatus: 409 },
) {}

/** Unknown, or someone else's: both look the same. */
export class DomainNotFound extends Schema.TaggedError<DomainNotFound>()(
  "DomainNotFound",
  { domain: Schema.String },
  { httpApiStatus: 404 },
) {}

/** SES couldn't be reached; nothing changed. Try again later. */
export class DomainUnavailable extends Schema.TaggedError<DomainUnavailable>()(
  "DomainUnavailable",
  {},
  { httpApiStatus: 503 },
) {}

const domainParam = { domain: Schema.String };

/**
 * Custom domains, signed in or with a `domains:read` / `domains:write` token (§20.20). A
 * check is a write: it runs DNS lookups and may change the domain's status. Adding one creates its SES identity and lists the records to
 * publish; `check` looks them up now (a cron also does, PLAN.md §20.18). Deleting one deletes
 * the caller's aliases on it.
 */
export const DomainsGroup = HttpApiGroup.make("domains")
  .add(
    requires("domains:read")(
      HttpApiEndpoint.get("list", "/domains", { success: Schema.Array(Domain) }),
    ),
  )
  .add(
    requires("domains:write")(
      HttpApiEndpoint.post("add", "/domains", {
        payload: Schema.Struct({ domain: Schema.String }),
        success: Domain.pipe(HttpApiSchema.status(201)),
        error: [InvalidDomain, DomainTaken, TooManyDomains, DomainUnavailable],
      }),
    ),
  )
  .add(
    requires("domains:read")(
      HttpApiEndpoint.get("get", "/domains/:domain", {
        params: domainParam,
        success: Domain,
        error: DomainNotFound,
      }),
    ),
  )
  .add(
    requires("domains:write")(
      HttpApiEndpoint.post("check", "/domains/:domain/check", {
        params: domainParam,
        success: Domain,
        error: [DomainNotFound, DomainUnavailable],
      }),
    ),
  )
  .add(
    requires("domains:write")(
      HttpApiEndpoint.patch("update", "/domains/:domain", {
        params: domainParam,
        payload: Schema.Struct({ isCatchAllEnabled: Schema.Boolean }),
        success: Domain,
        error: DomainNotFound,
      }),
    ),
  )
  .add(
    requires("domains:write")(
      HttpApiEndpoint.delete("remove", "/domains/:domain", {
        params: domainParam,
        error: [DomainNotFound, DomainUnavailable],
      }),
    ),
  )
  .middleware(Authentication)
  .prefix("/v1");
