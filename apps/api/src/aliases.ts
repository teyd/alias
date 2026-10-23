import { Address, SharedDomains } from "@alias/core";
import {
  AliasNotFound,
  AliasTaken,
  type AliasView,
  Api,
  CurrentUser,
  InvalidAlias,
  type NewAlias,
} from "@alias/contracts";
import { AliasRepo, DomainRepo } from "@alias/db";
import { Inbox } from "@alias/inbox";
import { Publisher } from "@alias/webhooks";
import { deleteWithMail } from "./inboxes.ts";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";

type Mode = AliasView["mode"];

const view = (alias: AliasRepo.Alias): AliasView => ({
  id: alias.id,
  address: `${alias.localPart}@${alias.domain}`,
  mode: alias.mode,
  isActive: alias.isActive,
  forwardedCount: alias.forwardedCount,
  blockedCount: alias.blockedCount,
  retentionDays: Inbox.retentionOf(alias),
});

const invalid = (address: string, reason: InvalidAlias["reason"]) =>
  Effect.fail(new InvalidAlias({ address, reason }));

/** Stores a new alias for the caller and returns it as created. */
const insert = Effect.fn("aliases.insert")(function* (address: Address.MailAddress, mode: Mode) {
  const user = yield* CurrentUser;
  const crypto = yield* Crypto.Crypto;
  const repo = yield* AliasRepo.AliasRepo;
  const id = `al_${(yield* Effect.orDie(crypto.randomULID)).toLowerCase()}`;
  const createdAt = DateTime.toEpochMillis(yield* DateTime.now);
  const alias = { id, userId: user.userId, domain: address.domain, localPart: address.local };
  yield* repo.insert({ ...alias, mode, createdAt }).pipe(
    Effect.catchTags({
      AliasTaken: (error) => Effect.fail(new AliasTaken({ address: error.address })),
      DatabaseError: Effect.die,
    }),
  );
  const created = view({
    ...alias,
    mode,
    createdAt,
    isActive: true,
    forwardedCount: 0,
    blockedCount: 0,
    inboxExpiresAt: Option.none(),
    retentionDays: Option.none(),
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
const createRandom = Effect.fn("aliases.createRandom")(function* (requested: string, mode: Mode) {
  const shared = yield* SharedDomains.SharedDomains;
  const domain = requested.trim().toLowerCase();
  if (!Arr.contains(shared, domain)) return yield* invalid(requested, "unknown-domain");
  return yield* Address.randomLocal().pipe(
    Effect.orDie,
    Effect.flatMap((local) => insert({ local, domain }, mode)),
    Effect.retry({ times: 3, while: (error) => P.isTagged(error, "AliasTaken") }),
  );
});

/** Any local part on one of the caller's custom domains, while it is verified. */
const createOnCustom = Effect.fn("aliases.createOnCustom")(function* (
  address: Address.MailAddress,
  requested: string,
  mode: Mode,
) {
  const user = yield* CurrentUser;
  const domains = yield* DomainRepo.DomainRepo;
  const found = Option.filter(
    yield* Effect.orDie(domains.find(address.domain)),
    (domain) => domain.userId === user.userId,
  );
  if (Option.isNone(found)) return yield* invalid(requested, "unknown-domain");
  if (found.value.status !== "verified") return yield* invalid(requested, "domain-not-verified");
  return yield* insert(address, mode);
});

/** Any local part on the caller's own subdomain of a shared domain, or custom domain. */
const createAddress = Effect.fn("aliases.createAddress")(function* (requested: string, mode: Mode) {
  const user = yield* CurrentUser;
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
    UserSubdomain: ({ username }) => {
      if (username !== user.username) return invalid(requested, "not-your-subdomain");
      // The subdomain is the user's, but abuse@ and postmaster@ on it are about our domain.
      if (Address.isRoleLocal(address.local)) return invalid(requested, "role-address");
      return insert(address, mode);
    },
    Custom: () => createOnCustom(address, requested, mode),
  });
});

/** What the alias handlers use. The group captures them once, at startup. */
type AliasServices =
  | Crypto.Crypto
  | AliasRepo.AliasRepo
  | DomainRepo.DomainRepo
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

/** The caller's aliases, oldest first. Temporary inboxes are listed under /v1/inboxes. */
export const list = Effect.fn("aliases.list")(function* () {
  const user = yield* CurrentUser;
  const repo = yield* AliasRepo.AliasRepo;
  return Arr.map(
    Arr.filter(yield* Effect.orDie(repo.listByUser(user.userId)), (alias) =>
      Option.isNone(alias.inboxExpiresAt),
    ),
    view,
  );
});

/** Where the caller may create aliases. */
export const domains = Effect.fn("aliases.domains")(function* () {
  const user = yield* CurrentUser;
  const shared = yield* SharedDomains.SharedDomains;
  const repo = yield* DomainRepo.DomainRepo;
  const custom = yield* Effect.orDie(repo.listByUser(user.userId));
  return {
    shared,
    subdomains: Arr.map(shared, (domain) => `${user.username}.${domain}`),
    custom: Arr.map(
      Arr.filter(custom, (domain) => domain.status === "verified"),
      (domain) => domain.domain,
    ),
  };
});

export const create = (payload: NewAlias) =>
  Match.valueTags(payload, {
    Random: ({ domain, mode }) => createRandom(domain, mode),
    Address: ({ address, mode }) => createAddress(address, mode),
  });

/** Changes the caller's alias; only what's given changes. */
export const update = Effect.fn("aliases.update")(function* (
  params: AliasParams,
  changes: {
    readonly mode?: Mode;
    readonly isActive?: boolean;
    readonly retentionDays?: AliasView["retentionDays"];
  },
) {
  const user = yield* CurrentUser;
  const repo = yield* AliasRepo.AliasRepo;
  const updated = yield* repo
    .update({ userId: user.userId, domain: params.domain, localPart: params.local }, changes)
    .pipe(
      Effect.catchTags({
        NoSuchAlias: () => Effect.fail(notFound(params)),
        DatabaseError: Effect.die,
      }),
    );
  return view(updated);
});

export const AliasesLive = HttpApiBuilder.group(Api, "aliases", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<AliasServices>();
    return handlers
      .handle("list", () => Effect.provide(list(), services))
      .handle("domains", () => Effect.provide(domains(), services))
      .handle("create", ({ payload }) => Effect.provide(create(payload), services))
      .handle("lookup", ({ params }) =>
        Effect.provide(Effect.map(ownedAlias(params), view), services),
      )
      .handle("update", ({ params, payload }) => Effect.provide(update(params, payload), services))
      .handle("remove", ({ params }) => Effect.provide(remove(params), services));
  }),
);
