import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { AccountGroup, AuthGroup, Authentication } from "./Auth.ts";

const Health = Schema.Struct({
  status: Schema.Literal("ok"),
});

const AliasMode = Schema.Literals(["forward", "inbox", "both"]);

const AliasView = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  mode: AliasMode,
  isActive: Schema.Boolean,
});
export type AliasView = typeof AliasView.Type;

/**
 * `Random` picks a fresh local part on a shared domain (`k7m2qx9pzr@alias.example`). `Address`
 * claims a full address on the caller's own subdomain (`shop@ada.alias.example`).
 */
const NewAlias = Schema.Union([
  Schema.TaggedStruct("Random", { domain: Schema.String, mode: AliasMode }),
  Schema.TaggedStruct("Address", { address: Schema.String, mode: AliasMode }),
]);

/** Only what's given changes. */
const AliasChanges = Schema.Struct({
  mode: Schema.optionalKey(AliasMode),
  isActive: Schema.optionalKey(Schema.Boolean),
});

/** Where the caller may create aliases: random ones on `shared`, any on `subdomains`. */
const AliasDomains = Schema.Struct({
  shared: Schema.Array(Schema.String),
  subdomains: Schema.Array(Schema.String),
});

/** The address is already taken, by the caller or by someone else. */
export class AliasTaken extends Schema.TaggedError<AliasTaken>()(
  "AliasTaken",
  { address: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The requested address isn't one the caller may create. */
export class InvalidAlias extends Schema.TaggedError<InvalidAlias>()(
  "InvalidAlias",
  {
    address: Schema.String,
    reason: Schema.Literals([
      "invalid-address",
      "unknown-domain",
      "not-your-subdomain",
      "random-only-on-shared-domain",
      "reserved-local-part",
    ]),
  },
  { httpApiStatus: 400 },
) {}

export class AliasNotFound extends Schema.TaggedError<AliasNotFound>()(
  "AliasNotFound",
  { address: Schema.String },
  { httpApiStatus: 404 },
) {}

const SystemGroup = HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", "/health", { success: Health }),
);

const AliasAddress = { domain: Schema.String, local: Schema.String };

/**
 * Signed-in only. An alias is addressed by its address, which is how it's stored. Other users'
 * aliases answer `AliasNotFound`, so lookups reveal nothing.
 */
const AliasesGroup = HttpApiGroup.make("aliases")
  .add(HttpApiEndpoint.get("list", "/aliases", { success: Schema.Array(AliasView) }))
  .add(HttpApiEndpoint.get("domains", "/aliases/domains", { success: AliasDomains }))
  .add(
    HttpApiEndpoint.post("create", "/aliases", {
      payload: NewAlias,
      success: AliasView.pipe(HttpApiSchema.status(201)),
      error: [InvalidAlias, AliasTaken],
    }),
  )
  .add(
    HttpApiEndpoint.get("lookup", "/aliases/:domain/:local", {
      params: AliasAddress,
      success: AliasView,
      error: AliasNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/aliases/:domain/:local", {
      params: AliasAddress,
      payload: AliasChanges,
      success: AliasView,
      error: AliasNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/aliases/:domain/:local", {
      params: AliasAddress,
      error: AliasNotFound,
    }),
  )
  .middleware(Authentication)
  .prefix("/v1");

export const Api = HttpApi.make("alias")
  .add(SystemGroup)
  .add(AuthGroup)
  .add(AccountGroup)
  .add(AliasesGroup);
