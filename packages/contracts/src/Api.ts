import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { AccountGroup, AuthGroup, Authentication } from "./Auth.ts";
import { requires } from "./Scopes.ts";
import { DomainsGroup } from "./Domains.ts";
import { RecipientsGroup } from "./Recipients.ts";
import { SettingsGroup } from "./Settings.ts";
import { TokensGroup } from "./Tokens.ts";
import { WebhooksGroup } from "./Webhooks.ts";

const Health = Schema.Struct({
  status: Schema.Literal("ok"),
});

const AliasMode = Schema.Literals(["forward", "inbox", "both"]);

const AliasView = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  mode: AliasMode,
  isActive: Schema.Boolean,
  /** Mail passed on to the owner. */
  forwardedCount: Schema.Number,
  /** Mail refused: spam, viruses, loops, blocked contacts, caps, a disabled alias. */
  blockedCount: Schema.Number,
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

/** Someone who wrote to an alias. Replies through its reverse alias reach it unless blocked. */
const Contact = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  /** The display name it first wrote with. */
  name: Schema.OptionFromOptionalKey(Schema.String),
  /** Mail from a blocked contact is dropped (and counted as blocked), and so are replies to it. */
  isBlocked: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
});
export type Contact = typeof Contact.Type;

/** No such contact on this alias. */
export class ContactNotFound extends Schema.TaggedError<ContactNotFound>()(
  "ContactNotFound",
  { contactId: Schema.String },
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
  .add(
    requires("aliases:read")(
      HttpApiEndpoint.get("list", "/aliases", { success: Schema.Array(AliasView) }),
    ),
  )
  .add(
    requires("aliases:read")(
      HttpApiEndpoint.get("domains", "/aliases/domains", { success: AliasDomains }),
    ),
  )
  .add(
    requires("aliases:write")(
      HttpApiEndpoint.post("create", "/aliases", {
        payload: NewAlias,
        success: AliasView.pipe(HttpApiSchema.status(201)),
        error: [InvalidAlias, AliasTaken],
      }),
    ),
  )
  .add(
    requires("aliases:read")(
      HttpApiEndpoint.get("lookup", "/aliases/:domain/:local", {
        params: AliasAddress,
        success: AliasView,
        error: AliasNotFound,
      }),
    ),
  )
  .add(
    requires("aliases:write")(
      HttpApiEndpoint.patch("update", "/aliases/:domain/:local", {
        params: AliasAddress,
        payload: AliasChanges,
        success: AliasView,
        error: AliasNotFound,
      }),
    ),
  )
  .add(
    requires("aliases:write")(
      HttpApiEndpoint.delete("remove", "/aliases/:domain/:local", {
        params: AliasAddress,
        error: AliasNotFound,
      }),
    ),
  )
  .middleware(Authentication)
  .prefix("/v1");

const ContactAddress = { ...AliasAddress, contactId: Schema.String };

/**
 * An alias's contacts, created as people write to it. Signed-in only, on the caller's own aliases;
 * other users' aliases answer `AliasNotFound`. Deleting a contact revokes its reverse alias; if it
 * writes again, it becomes a new contact with a new one.
 */
const ContactsGroup = HttpApiGroup.make("contacts")
  .add(
    requires("contacts:read")(
      HttpApiEndpoint.get("list", "/aliases/:domain/:local/contacts", {
        params: AliasAddress,
        success: Schema.Array(Contact),
        error: AliasNotFound,
      }),
    ),
  )
  .add(
    requires("contacts:write")(
      HttpApiEndpoint.patch("update", "/aliases/:domain/:local/contacts/:contactId", {
        params: ContactAddress,
        payload: Schema.Struct({ isBlocked: Schema.Boolean }),
        success: Contact,
        error: [AliasNotFound, ContactNotFound],
      }),
    ),
  )
  .add(
    requires("contacts:write")(
      HttpApiEndpoint.delete("remove", "/aliases/:domain/:local/contacts/:contactId", {
        params: ContactAddress,
        error: [AliasNotFound, ContactNotFound],
      }),
    ),
  )
  .middleware(Authentication)
  .prefix("/v1");

export const Api = HttpApi.make("alias")
  .add(SystemGroup)
  .add(AuthGroup)
  .add(AccountGroup)
  .add(AliasesGroup)
  .add(ContactsGroup)
  .add(RecipientsGroup)
  .add(DomainsGroup)
  .add(SettingsGroup)
  .add(TokensGroup)
  .add(WebhooksGroup);
