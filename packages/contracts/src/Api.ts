import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { AccountGroup, AuthGroup, Authentication } from "./Auth.ts";
import { DeviceGroup, OAuthGroup } from "./Device.ts";
import { ConsentGroup } from "./OAuth.ts";
import { OutboxGroup } from "./Outbox.ts";
import { InboxesGroup, RetentionDays } from "./Inboxes.ts";
import { AliasLabel, LabelsGroup } from "./Labels.ts";
import { requires } from "./Scopes.ts";
import { DomainsGroup } from "./Domains.ts";
import { FailuresGroup } from "./Failures.ts";
import { RecipientsGroup } from "./Recipients.ts";
import { BlocklistGroup, RulesGroup } from "./Rules.ts";
import { SecurityGroup } from "./Security.ts";
import { SettingsGroup } from "./Settings.ts";
import { TokensGroup } from "./Tokens.ts";
import { UsernamesGroup } from "./Usernames.ts";
import { WebhooksGroup } from "./Webhooks.ts";

/** Longest alias description, in UTF-16 code units. */
export const MAX_DESCRIPTION_LENGTH = 200;
/** Most labels on one alias. */
export const MAX_LABELS = 10;
/** Most recipients one alias forwards to (addy.io allows several too). */
export const MAX_ALIAS_RECIPIENTS = 5;
/** Most rows one import request may carry. */
export const MAX_IMPORT_ROWS = 100;

const Health = Schema.Struct({
  status: Schema.Literal("ok"),
});

const AliasMode = Schema.Literals(["forward", "inbox", "both"]);

/** The owner's note on what an alias is for (PLAN.md §20.31). Empty clears it. */
export const AliasDescription = Schema.Trim.check(Schema.isMaxLength(MAX_DESCRIPTION_LENGTH));
export type AliasDescription = typeof AliasDescription.Type;

/** An alias's labels: at most `MAX_LABELS`, each once. */
export const AliasLabels = Schema.Array(AliasLabel).check(
  Schema.isMaxLength(MAX_LABELS),
  Schema.isUnique(),
);
export type AliasLabels = typeof AliasLabels.Type;

/**
 * The owner's verified recipients mail to the alias goes to, by id, in order. Empty: the
 * default recipient.
 */
const AliasRecipientIds = Schema.Array(Schema.String).check(
  Schema.isMaxLength(MAX_ALIAS_RECIPIENTS),
  Schema.isUnique(),
);

const AliasView = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  mode: AliasMode,
  isActive: Schema.Boolean,
  /** Mail passed on to the owner. */
  forwardedCount: Schema.Int,
  /** Mail refused: spam, viruses, loops, blocked contacts, caps, a disabled alias. */
  blockedCount: Schema.Int,
  /** How long mail stored in inbox mode is kept (PLAN.md §20.22). */
  retentionDays: RetentionDays,
  createdAt: Schema.DateTimeUtcFromString,
  description: Schema.OptionFromOptionalKey(Schema.String),
  labels: Schema.Array(Schema.String),
  /**
   * The recipients (ids from `/v1/recipients`) mail is forwarded to. Empty: the default one.
   * Recipients deleted since are left out; if none of these is verified any more, mail goes to
   * the default recipient.
   */
  recipientIds: Schema.Array(Schema.String),
});
export type AliasView = typeof AliasView.Type;

/** Optional on creation and on changes; only what's given is set. */
const AliasDetails = {
  description: Schema.optionalKey(AliasDescription),
  labels: Schema.optionalKey(AliasLabels),
  recipientIds: Schema.optionalKey(AliasRecipientIds),
};

/**
 * `Random` picks a fresh local part on a shared domain (`k7m2qx9pzr@alias.example`). `Address`
 * claims a full address on the caller's own subdomain (`shop@ada.alias.example`) or on one of
 * their verified custom domains (`shop@ada.example`).
 */
const NewAlias = Schema.Union([
  Schema.TaggedStruct("Random", { domain: Schema.String, mode: AliasMode, ...AliasDetails }),
  Schema.TaggedStruct("Address", { address: Schema.String, mode: AliasMode, ...AliasDetails }),
]);
export type NewAlias = typeof NewAlias.Type;

/** Only what's given changes. */
const AliasChanges = Schema.Struct({
  mode: Schema.optionalKey(AliasMode),
  isActive: Schema.optionalKey(Schema.Boolean),
  retentionDays: Schema.optionalKey(RetentionDays),
  ...AliasDetails,
});
export type AliasChanges = typeof AliasChanges.Type;

/**
 * Where the caller may create aliases: random ones on `shared`, any on `subdomains` (those of
 * every username of theirs, the primary one's first) and on their verified `custom` domains.
 */
const AliasDomains = Schema.Struct({
  shared: Schema.Array(Schema.String),
  subdomains: Schema.Array(Schema.String),
  custom: Schema.Array(Schema.String),
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
      // One of the caller's custom domains, but not verified (yet, or any more).
      "domain-not-verified",
      "random-only-on-shared-domain",
      "reserved-local-part",
      // A role mailbox (RFC 2142: abuse, postmaster…) on the caller's subdomain (PLAN.md §20.27).
      "role-address",
    ]),
  },
  { httpApiStatus: 400 },
) {}

/** A recipient chosen for an alias isn't one of the caller's verified recipients. */
export class InvalidAliasRecipient extends Schema.TaggedError<InvalidAliasRecipient>()(
  "InvalidAliasRecipient",
  {
    recipientId: Schema.String,
    /** `unknown`: no such recipient of the caller's; `unverified`: not confirmed yet. */
    reason: Schema.Literals(["unknown", "unverified"]),
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

/**
 * A contact the owner added, with its reverse alias: mail the owner sends there from a verified
 * forwarding address goes to the contact from the alias, like a reply (PLAN.md §20.33).
 */
const AddedContact = Schema.Struct({
  ...Contact.fields,
  /** `<alias>+r.<token>@<alias domain>`, to send to from the owner's own mailbox. */
  replyAddress: Schema.String,
});
export type AddedContact = typeof AddedContact.Type;

/**
 * The contact can't be added: not a usable address, one the owner's blocklist names (PLAN.md
 * §20.32), or the day's allowance of new recipients is used up.
 */
export class InvalidContact extends Schema.TaggedError<InvalidContact>()(
  "InvalidContact",
  { reason: Schema.Literals(["invalid-address", "blocked-address", "recipient-limit"]) },
  { httpApiStatus: 422 },
) {}

/** No such contact on this alias. */
export class ContactNotFound extends Schema.TaggedError<ContactNotFound>()(
  "ContactNotFound",
  { contactId: Schema.String },
  { httpApiStatus: 404 },
) {}

/**
 * One alias in an export (PLAN.md §20.31): everything about it but its contacts, with its
 * recipients by address.
 */
const ExportedAlias = Schema.Struct({
  address: Schema.String,
  isActive: Schema.Boolean,
  mode: AliasMode,
  description: Schema.OptionFromOptionalKey(Schema.String),
  labels: Schema.Array(Schema.String),
  /** Addresses of the recipients mail goes to. Empty: the default recipient. */
  recipients: Schema.Array(Schema.String),
  forwardedCount: Schema.Int,
  blockedCount: Schema.Int,
  createdAt: Schema.DateTimeUtcFromString,
});
export type ExportedAlias = typeof ExportedAlias.Type;

export const AliasExport = Schema.Struct({
  exportedAt: Schema.DateTimeUtcFromString,
  aliases: Schema.Array(ExportedAlias),
});
export type AliasExport = typeof AliasExport.Type;

/**
 * One row of an import: an address on the caller's subdomain or custom domain to create, with
 * optional details. Fields are checked per row, so one bad row fails only itself.
 */
const ImportRow = Schema.Struct({
  address: Schema.String.check(Schema.isMaxLength(320)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
  labels: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(50)),
  ),
  isActive: Schema.optionalKey(Schema.Boolean),
});
export type ImportRow = typeof ImportRow.Type;

/** Why one row wasn't created: an `InvalidAlias` reason, or one of these. */
export const ImportFailure = Schema.Literals([
  "invalid-address",
  "unknown-domain",
  "not-your-subdomain",
  "domain-not-verified",
  "random-only-on-shared-domain",
  "reserved-local-part",
  "role-address",
  "taken",
  // The address came up earlier in the same import.
  "duplicate",
  "invalid-description",
  "invalid-labels",
]);
export type ImportFailure = typeof ImportFailure.Type;

const ImportResult = Schema.Union([
  Schema.TaggedStruct("Created", { row: Schema.Int, alias: AliasView }),
  Schema.TaggedStruct("Failed", { row: Schema.Int, address: Schema.String, reason: ImportFailure }),
]);
export type ImportResult = typeof ImportResult.Type;

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
        error: [InvalidAlias, AliasTaken, InvalidAliasRecipient],
      }),
    ),
  )
  .add(
    // Names the recipients' addresses, so a token needs to read both.
    requires(
      "aliases:read",
      "recipients:read",
    )(HttpApiEndpoint.get("export", "/aliases/export", { success: AliasExport })),
  )
  .add(
    requires("aliases:write")(
      HttpApiEndpoint.post("import", "/aliases/import", {
        payload: Schema.Struct({
          aliases: Schema.Array(ImportRow).check(
            Schema.isMinLength(1),
            Schema.isMaxLength(MAX_IMPORT_ROWS),
          ),
        }),
        success: Schema.Struct({ results: Schema.Array(ImportResult) }),
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
        error: [AliasNotFound, InvalidAliasRecipient],
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
 * An alias's contacts, created as people write to it or as the owner adds them (to write to them
 * first, PLAN.md §20.33). Signed-in only, on the caller's own aliases; other users' aliases answer
 * `AliasNotFound`. Deleting a contact revokes its reverse alias; if it writes again, it becomes a
 * new contact with a new one.
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
      HttpApiEndpoint.post("create", "/aliases/:domain/:local/contacts", {
        params: AliasAddress,
        payload: Schema.Struct({ address: Schema.String }),
        success: AddedContact,
        error: [AliasNotFound, InvalidContact],
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
  .add(LabelsGroup)
  .add(InboxesGroup)
  .add(RecipientsGroup)
  .add(DomainsGroup)
  .add(SettingsGroup)
  .add(UsernamesGroup)
  .add(BlocklistGroup)
  .add(RulesGroup)
  .add(SecurityGroup)
  .add(TokensGroup)
  .add(WebhooksGroup)
  .add(OAuthGroup)
  .add(DeviceGroup)
  .add(ConsentGroup)
  .add(OutboxGroup)
  .add(FailuresGroup);
