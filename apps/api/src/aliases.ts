import { Address, SharedDomains } from "@alias/core";
import {
  type AliasChanges,
  AliasDescription,
  AliasLabel,
  AliasNotFound,
  AliasTaken,
  type AliasView,
  Api,
  CurrentUser,
  type ExportedAlias,
  type ImportFailure,
  type ImportResult,
  type ImportRow,
  InvalidAlias,
  InvalidAliasRecipient,
  MAX_LABELS,
  type NewAlias,
} from "@alias/contracts";
import { AliasRepo, DomainRepo, RecipientRepo, type UsernameRepo } from "@alias/db";
import { Inbox } from "@alias/inbox";
import { Publisher } from "@alias/webhooks";
import { deleteWithMail } from "./inboxes.ts";
import { callerSubdomains, isCallerUsername } from "./usernames.ts";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

type Mode = AliasView["mode"];

/** What may be set on an alias besides its address and mode (PLAN.md §20.31). */
interface Details {
  readonly description?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly recipientIds?: ReadonlyArray<string>;
}

/** The caller's recipients, read once per request: views name only those that still exist. */
const recipientsOf = Effect.fn("aliases.recipientsOf")(function* (userId: string) {
  return yield* Effect.orDie((yield* RecipientRepo.RecipientRepo).list(userId));
});

const view =
  (recipients: ReadonlyArray<RecipientRepo.Recipient>) =>
  (alias: AliasRepo.Alias): AliasView => ({
    id: alias.id,
    address: `${alias.localPart}@${alias.domain}`,
    mode: alias.mode,
    isActive: alias.isActive,
    forwardedCount: alias.forwardedCount,
    blockedCount: alias.blockedCount,
    retentionDays: Inbox.retentionOf(alias),
    createdAt: DateTime.makeUnsafe(alias.createdAt),
    description: alias.description,
    labels: alias.labels,
    recipientIds: Arr.filter(alias.recipientIds, (id) =>
      Arr.some(recipients, (recipient) => recipient.id === id),
    ),
  });

/** One alias as the caller sees it, after reading their recipients. */
const viewOne = Effect.fn("aliases.viewOne")(function* (alias: AliasRepo.Alias) {
  return view(yield* recipientsOf(alias.userId))(alias);
});

/** Recipients chosen for an alias must be the caller's own, and verified. */
const checkRecipients = Effect.fn("aliases.checkRecipients")(function* (
  recipientIds: ReadonlyArray<string>,
) {
  if (Arr.isReadonlyArrayEmpty(recipientIds)) return;
  const recipients = yield* recipientsOf((yield* CurrentUser).userId);
  yield* Effect.forEach(
    recipientIds,
    (recipientId) => {
      const found = Arr.findFirst(recipients, (recipient) => recipient.id === recipientId);
      if (Option.isNone(found)) {
        return Effect.fail(new InvalidAliasRecipient({ recipientId, reason: "unknown" }));
      }
      return Option.isNone(found.value.verifiedAt)
        ? Effect.fail(new InvalidAliasRecipient({ recipientId, reason: "unverified" }))
        : Effect.void;
    },
    { concurrency: 1, discard: true },
  );
});

const invalid = (address: string, reason: InvalidAlias["reason"]) =>
  Effect.fail(new InvalidAlias({ address, reason }));

/** Stores a new alias for the caller and returns it as created. */
const insert = Effect.fn("aliases.insert")(function* (
  address: Address.MailAddress,
  mode: Mode,
  details: Details,
  isActive = true,
) {
  const user = yield* CurrentUser;
  const crypto = yield* Crypto.Crypto;
  const repo = yield* AliasRepo.AliasRepo;
  yield* checkRecipients(details.recipientIds ?? []);
  const id = `al_${(yield* Effect.orDie(crypto.randomULID)).toLowerCase()}`;
  const createdAt = DateTime.toEpochMillis(yield* DateTime.now);
  const alias = { id, userId: user.userId, domain: address.domain, localPart: address.local };
  yield* repo.insert({ ...alias, ...details, mode, createdAt, isActive }).pipe(
    Effect.catchTags({
      AliasTaken: (error) => Effect.fail(new AliasTaken({ address: error.address })),
      DatabaseError: Effect.die,
    }),
  );
  const created = yield* viewOne({
    ...alias,
    mode,
    createdAt,
    isActive,
    forwardedCount: 0,
    blockedCount: 0,
    inboxExpiresAt: Option.none(),
    retentionDays: Option.none(),
    description: Option.filter(Option.fromUndefinedOr(details.description), Str.isNonEmpty),
    labels: details.labels ?? [],
    recipientIds: details.recipientIds ?? [],
  });
  const publisher = yield* Publisher.Publisher;
  yield* publisher.publish(
    user.userId,
    {
      type: "alias.created",
      timestamp: DateTime.formatIso(DateTime.makeUnsafe(createdAt)),
      data: { aliasId: id, address: created.address, origin: "api" },
    },
    id,
  );
  return created;
});

/** A fresh local part on one of the shared domains. Draws again if it is already taken. */
const createRandom = Effect.fn("aliases.createRandom")(function* (
  requested: string,
  mode: Mode,
  details: Details,
) {
  const shared = yield* SharedDomains.SharedDomains;
  const domain = requested.trim().toLowerCase();
  if (!Arr.contains(shared, domain)) return yield* invalid(requested, "unknown-domain");
  return yield* Address.randomLocal().pipe(
    Effect.orDie,
    Effect.flatMap((local) => insert({ local, domain }, mode, details)),
    Effect.retry({ times: 3, while: (error) => P.isTagged(error, "AliasTaken") }),
  );
});

/** Any local part on one of the caller's custom domains, while it is verified. */
const createOnCustom = Effect.fn("aliases.createOnCustom")(function* (
  address: Address.MailAddress,
  requested: string,
  mode: Mode,
  details: Details,
  isActive: boolean,
) {
  const user = yield* CurrentUser;
  const domains = yield* DomainRepo.DomainRepo;
  const found = Option.filter(
    yield* Effect.orDie(domains.find(address.domain)),
    (domain) => domain.userId === user.userId,
  );
  if (Option.isNone(found)) return yield* invalid(requested, "unknown-domain");
  if (found.value.status !== "verified") return yield* invalid(requested, "domain-not-verified");
  return yield* insert(address, mode, details, isActive);
});

/** Any local part on a subdomain of one of the caller's usernames, except role mailboxes. */
const createOnSubdomain = Effect.fn("aliases.createOnSubdomain")(function* (
  address: Address.MailAddress,
  username: string,
  requested: string,
  mode: Mode,
  details: Details,
  isActive: boolean,
) {
  if (!(yield* isCallerUsername(username))) return yield* invalid(requested, "not-your-subdomain");
  // The subdomain is the user's, but abuse@ and postmaster@ on it are about our domain.
  if (Address.isRoleLocal(address.local)) return yield* invalid(requested, "role-address");
  return yield* insert(address, mode, details, isActive);
});

/** Any local part on one of the caller's own subdomains of a shared domain, or custom domain. */
const createAddress = Effect.fn("aliases.createAddress")(function* (
  requested: string,
  mode: Mode,
  details: Details,
  isActive = true,
) {
  const shared = yield* SharedDomains.SharedDomains;
  const address = yield* Address.parse(requested).pipe(
    Effect.catchTag("InvalidAddress", () => invalid(requested, "invalid-address")),
  );
  // `<alias>+r.<token>` is the reverse-alias shape replies are routed by.
  if (Option.isSome(Address.reverseToken(address))) {
    return yield* invalid(requested, "reserved-local-part");
  }
  return yield* Address.Destination.$match(Address.classify(address, shared), {
    SharedRandom: () => invalid(requested, "random-only-on-shared-domain"),
    UserSubdomain: ({ username }) =>
      createOnSubdomain(address, username, requested, mode, details, isActive),
    Custom: () => createOnCustom(address, requested, mode, details, isActive),
  });
});

/** What the alias handlers use. The group captures them once, at startup. */
type AliasServices =
  | Crypto.Crypto
  | AliasRepo.AliasRepo
  | RecipientRepo.RecipientRepo
  | DomainRepo.DomainRepo
  | UsernameRepo.UsernameRepo
  | SharedDomains.SharedDomains
  | Publisher.Publisher
  | Inbox.Inbox;

interface AliasParams {
  readonly domain: string;
  readonly local: string;
}

const notFound = (params: AliasParams) =>
  new AliasNotFound({ address: `${params.local}@${params.domain}`.toLowerCase() });

/** The caller's alias at this address. Someone else's looks exactly like a missing one. */
export const ownedAlias = Effect.fn("aliases.ownedAlias")(function* (params: AliasParams) {
  const user = yield* CurrentUser;
  const repo = yield* AliasRepo.AliasRepo;
  const alias = yield* Effect.orDie(repo.findByAddress(params.domain, params.local));
  return yield* Option.match(
    Option.filter(alias, (found) => found.userId === user.userId),
    { onNone: () => Effect.fail(notFound(params)), onSome: Effect.succeed },
  );
});

/** Deletes the caller's alias with any mail it stored, and tells their webhooks. */
const remove = Effect.fn("aliases.remove")(function* (params: AliasParams) {
  const alias = yield* ownedAlias(params);
  yield* deleteWithMail(alias).pipe(
    Effect.catchTags({
      NoSuchAlias: () => Effect.fail(notFound(params)),
      DatabaseError: Effect.die,
    }),
  );
});

/** The caller's aliases, oldest first, without temporary inboxes (listed under /v1/inboxes). */
const owned = Effect.fn("aliases.owned")(function* () {
  const user = yield* CurrentUser;
  const repo = yield* AliasRepo.AliasRepo;
  return Arr.filter(yield* Effect.orDie(repo.listByUser(user.userId)), (alias) =>
    Option.isNone(alias.inboxExpiresAt),
  );
});

/** The caller's aliases, oldest first. Temporary inboxes are listed under /v1/inboxes. */
export const list = Effect.fn("aliases.list")(function* () {
  const aliases = yield* owned();
  return Arr.map(aliases, view(yield* recipientsOf((yield* CurrentUser).userId)));
});

/** Every alias of the caller's with its details, recipients by address, and counters. */
const exportAll = Effect.fn("aliases.exportAll")(function* () {
  const aliases = yield* owned();
  const recipients = yield* recipientsOf((yield* CurrentUser).userId);
  const exported = Arr.map(aliases, (alias): ExportedAlias => ({
    address: `${alias.localPart}@${alias.domain}`,
    isActive: alias.isActive,
    mode: alias.mode,
    description: alias.description,
    labels: alias.labels,
    recipients: Arr.filterMap(alias.recipientIds, (id) =>
      Result.fromOption(
        Option.map(
          Arr.findFirst(recipients, (recipient) => recipient.id === id),
          (recipient) => recipient.address,
        ),
        () => undefined,
      ),
    ),
    forwardedCount: alias.forwardedCount,
    blockedCount: alias.blockedCount,
    createdAt: DateTime.makeUnsafe(alias.createdAt),
  }));
  return { exportedAt: yield* DateTime.now, aliases: exported };
});

const decodeDescription = Schema.decodeUnknownOption(AliasDescription);
const decodeLabel = Schema.decodeUnknownOption(AliasLabel);

/** One import row's details, checked like the API checks them; the failure names the field. */
const importDetails = (row: ImportRow): Result.Result<Details, ImportFailure> => {
  const description = Option.match(Option.fromUndefinedOr(row.description), {
    onNone: () => Result.succeed(Option.none<string>()),
    onSome: (text) =>
      Result.map(
        Result.fromOption(decodeDescription(text), (): ImportFailure => "invalid-description"),
        Option.some,
      ),
  });
  const labels = Arr.dedupe(
    Arr.filterMap(row.labels ?? [], (label) =>
      Result.fromOption(decodeLabel(label), () => undefined),
    ),
  );
  const isLabelsValid =
    Arr.length(labels) === Arr.length(Arr.dedupe(row.labels ?? [])) &&
    Arr.length(labels) <= MAX_LABELS;
  return Result.flatMap(description, (found) =>
    isLabelsValid
      ? Result.succeed<Details>({
          labels,
          ...Option.match(found, { onNone: () => ({}), onSome: (text) => ({ description: text }) }),
        })
      : Result.fail<ImportFailure>("invalid-labels"),
  );
};

/**
 * Creates the listed aliases on the caller's subdomain or custom domains, one after the other,
 * each as `POST /v1/aliases` with an `Address` would. A row that fails only fails itself.
 */
const importAll = Effect.fn("aliases.importAll")(function* (rows: ReadonlyArray<ImportRow>) {
  const results = yield* Effect.forEach(
    rows,
    (row, index): Effect.Effect<ImportResult, never, AliasServices | CurrentUser> => {
      const number = index + 1;
      const failed = (reason: ImportFailure) =>
        Effect.succeed<ImportResult>({ _tag: "Failed", row: number, address: row.address, reason });
      const normalized = Str.toLowerCase(Str.trim(row.address));
      const isRepeated = Arr.some(
        Arr.take(rows, index),
        (earlier) => Str.toLowerCase(Str.trim(earlier.address)) === normalized,
      );
      if (isRepeated) return failed("duplicate");
      const details = importDetails(row);
      if (Result.isFailure(details)) return failed(details.failure);
      return createAddress(
        Str.trim(row.address),
        "forward",
        details.success,
        row.isActive ?? true,
      ).pipe(
        Effect.map((alias): ImportResult => ({ _tag: "Created", row: number, alias })),
        Effect.catchTags({
          InvalidAlias: (error) => failed(error.reason),
          AliasTaken: () => failed("taken"),
          // Imports set no recipients.
          InvalidAliasRecipient: Effect.die,
        }),
      );
    },
    { concurrency: 1 },
  );
  return { results };
});

/** Where the caller may create aliases. */
export const domains = Effect.fn("aliases.domains")(function* () {
  const user = yield* CurrentUser;
  const shared = yield* SharedDomains.SharedDomains;
  const repo = yield* DomainRepo.DomainRepo;
  const custom = yield* Effect.orDie(repo.listByUser(user.userId));
  return {
    shared,
    subdomains: yield* callerSubdomains(),
    custom: Arr.map(
      Arr.filter(custom, (domain) => domain.status === "verified"),
      (domain) => domain.domain,
    ),
  };
});

export const create = (payload: NewAlias) =>
  Match.valueTags(payload, {
    Random: ({ domain, mode, ...details }) => createRandom(domain, mode, details),
    Address: ({ address, mode, ...details }) => createAddress(address, mode, details),
  });

/** Changes the caller's alias; only what's given changes. */
export const update = Effect.fn("aliases.update")(function* (
  params: AliasParams,
  changes: AliasChanges,
) {
  const user = yield* CurrentUser;
  const repo = yield* AliasRepo.AliasRepo;
  yield* checkRecipients(changes.recipientIds ?? []);
  const { description, ...rest } = changes;
  const updated = yield* repo
    .update(
      { userId: user.userId, domain: params.domain, localPart: params.local },
      {
        ...rest,
        ...Option.match(Option.fromUndefinedOr(description), {
          onNone: () => ({}),
          onSome: (text) => ({ description: Option.filter(Option.some(text), Str.isNonEmpty) }),
        }),
      },
    )
    .pipe(
      Effect.catchTags({
        NoSuchAlias: () => Effect.fail(notFound(params)),
        DatabaseError: Effect.die,
      }),
    );
  return yield* viewOne(updated);
});

export const AliasesLive = HttpApiBuilder.group(Api, "aliases", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<AliasServices>();
    return handlers
      .handle("list", () => Effect.provide(list(), services))
      .handle("domains", () => Effect.provide(domains(), services))
      .handle("create", ({ payload }) => Effect.provide(create(payload), services))
      .handle("export", () => Effect.provide(exportAll(), services))
      .handle("import", ({ payload }) => Effect.provide(importAll(payload.aliases), services))
      .handle("lookup", ({ params }) =>
        Effect.provide(Effect.flatMap(ownedAlias(params), viewOne), services),
      )
      .handle("update", ({ params, payload }) => Effect.provide(update(params, payload), services))
      .handle("remove", ({ params }) => Effect.provide(remove(params), services));
  }),
);
