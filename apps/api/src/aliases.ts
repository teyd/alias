import { Address, SharedDomains } from "@alias/core";
import {
  AliasNotFound,
  AliasTaken,
  type AliasView,
  Api,
  CurrentUser,
  InvalidAlias,
} from "@alias/contracts";
import { AliasRepo } from "@alias/db";
import { Publisher } from "@alias/webhooks";
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

/** Any local part on the caller's own subdomain of a shared domain. */
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
    UserSubdomain: ({ username }) =>
      username === user.username ? insert(address, mode) : invalid(requested, "not-your-subdomain"),
    Custom: () => invalid(requested, "unknown-domain"),
  });
});

/** What the alias handlers use. The group captures them once, at startup. */
type AliasServices =
  | Crypto.Crypto
  | AliasRepo.AliasRepo
  | SharedDomains.SharedDomains
  | Publisher.Publisher;

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

/** Deletes the caller's alias and tells their webhooks. */
const remove = Effect.fn("aliases.remove")(function* (params: AliasParams) {
  const alias = yield* ownedAlias(params);
  const repo = yield* AliasRepo.AliasRepo;
  yield* repo.delete(alias).pipe(
    Effect.catchTags({
      NoSuchAlias: () => Effect.fail(notFound(params)),
      DatabaseError: Effect.die,
    }),
  );
  const publisher = yield* Publisher.Publisher;
  yield* publisher.publish(
    alias.userId,
    {
      type: "alias.deleted",
      timestamp: DateTime.formatIso(yield* DateTime.now),
      data: { aliasId: alias.id, address: `${alias.localPart}@${alias.domain}` },
    },
    alias.id,
  );
});

export const AliasesLive = HttpApiBuilder.group(Api, "aliases", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<AliasServices>();
    const repo = yield* AliasRepo.AliasRepo;
    const shared = yield* SharedDomains.SharedDomains;
    const owned = (params: { readonly domain: string; readonly local: string }) =>
      Effect.map(Effect.service(CurrentUser), (user) => ({
        userId: user.userId,
        domain: params.domain,
        localPart: params.local,
      }));
    return handlers
      .handle("list", () =>
        Effect.service(CurrentUser).pipe(
          Effect.flatMap((user) => Effect.orDie(repo.listByUser(user.userId))),
          Effect.map(Arr.map(view)),
        ),
      )
      .handle("domains", () =>
        Effect.map(Effect.service(CurrentUser), (user) => ({
          shared,
          subdomains: Arr.map(shared, (domain) => `${user.username}.${domain}`),
        })),
      )
      .handle("create", ({ payload }) =>
        Effect.provide(
          Match.valueTags(payload, {
            Random: ({ domain, mode }) => createRandom(domain, mode),
            Address: ({ address, mode }) => createAddress(address, mode),
          }),
          services,
        ),
      )
      .handle("lookup", ({ params }) =>
        ownedAlias(params).pipe(Effect.map(view), Effect.provideService(AliasRepo.AliasRepo, repo)),
      )
      .handle("update", ({ params, payload }) =>
        owned(params).pipe(
          Effect.flatMap((address) => repo.update(address, payload)),
          Effect.map(view),
          Effect.catchTags({
            NoSuchAlias: () => Effect.fail(notFound(params)),
            DatabaseError: Effect.die,
          }),
        ),
      )
      .handle("remove", ({ params }) => Effect.provide(remove(params), services));
  }),
);
