import { Identities } from "@alias/aws";
import {
  Api,
  CurrentUser,
  type Domain,
  DomainNotFound,
  DomainTaken,
  DomainUnavailable,
  InvalidDomain,
  TooManyDomains,
} from "@alias/contracts";
import { Address, SharedDomains } from "@alias/core";
import { AliasRepo, DomainRepo } from "@alias/db";
import { type Doh, DomainSetup } from "@alias/dns";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import { HttpApiBuilder } from "effect/http-api";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as DomainVerification from "./DomainVerification.ts";

/** The records to publish, each with what the last check found. */
const view = (domain: DomainRepo.Domain): Domain => ({
  domain: domain.domain,
  status: domain.status,
  isCatchAllEnabled: domain.isCatchAllEnabled,
  createdAt: domain.createdAt,
  verifiedAt: domain.verifiedAt,
  checkedAt: domain.checkedAt,
  expiresAt:
    domain.status === "pending"
      ? Option.some(DateTime.addDuration(domain.createdAt, DomainVerification.PENDING_LIFETIME))
      : Option.none(),
  records: Arr.map(DomainSetup.records(DomainVerification.setupOf(domain)), (record) => ({
    ...record,
    state: Option.getOrElse(
      Option.map(
        Arr.findFirst(
          domain.checks,
          (check) => check.type === record.type && check.name === record.name,
        ),
        (check) => check.state,
      ),
      () => "unchecked" as const,
    ),
  })),
});

/**
 * `Example.COM.` → `example.com`. Refuses non-domains, the shared domains, their subdomains and
 * their parents: an SES identity covers its subdomains, so either way one user's identity would
 * cover the service's own mail.
 */
const normalize = Effect.fn("domains.normalize")(function* (requested: string) {
  const shared = yield* SharedDomains.SharedDomains;
  const trimmed = Str.toLowerCase(Str.trim(requested));
  const domain = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (!Address.isDomain(domain)) {
    return yield* new InvalidDomain({ domain: requested, reason: "invalid" });
  }
  const overlaps = (a: string, b: string) => a === b || a.endsWith(`.${b}`);
  if (Arr.some(shared, (own) => overlaps(domain, own) || overlaps(own, domain))) {
    return yield* new InvalidDomain({ domain: requested, reason: "shared-domain" });
  }
  return domain;
});

const notFound = (domain: string) => new DomainNotFound({ domain: Str.toLowerCase(domain) });

const unavailable = (error: Identities.IdentityUnavailable) =>
  Effect.logWarning("SES identity call failed", error.operation, error.reason).pipe(
    Effect.andThen(Effect.fail(new DomainUnavailable())),
  );

/** The caller's domain; someone else's looks exactly like a missing one. */
const owned = Effect.fn("domains.owned")(function* (requested: string) {
  const user = yield* CurrentUser;
  const repo = yield* DomainRepo.DomainRepo;
  const found = yield* Effect.orDie(repo.find(Str.toLowerCase(requested)));
  return yield* Option.match(
    Option.filter(found, (domain) => domain.userId === user.userId),
    { onNone: () => Effect.fail(notFound(requested)), onSome: Effect.succeed },
  );
});

/**
 * Claims the domain, then creates its SES identity. The claim comes first so two users adding
 * the same domain never both reach SES; an identity left by an interrupted earlier attempt is
 * adopted. If SES can't be reached, the claim is released again.
 */
const add = Effect.fn("domains.add")(function* (requested: string) {
  const user = yield* CurrentUser;
  const repo = yield* DomainRepo.DomainRepo;
  const identities = yield* Identities.Identities;
  const crypto = yield* Crypto.Crypto;
  const domain = yield* normalize(requested);
  const verificationToken = Hex.encode(yield* Effect.orDie(crypto.randomBytes(16)));
  yield* repo
    .claim(
      { domain, userId: user.userId, verificationToken, createdAt: yield* DateTime.now },
      DomainVerification.MAX_DOMAINS_PER_USER,
    )
    .pipe(
      Effect.catchTags({
        DomainTaken: () => Effect.fail(new DomainTaken({ domain })),
        TooManyDomains: (error) => Effect.fail(new TooManyDomains({ limit: error.limit })),
        DatabaseError: Effect.die,
      }),
    );
  const identity = yield* identities.create(domain, DomainSetup.mailFromDomain(domain)).pipe(
    Effect.catchTag("IdentityExists", () =>
      Effect.flatMap(identities.get(domain), (found) =>
        Effect.fromOption(found).pipe(
          Effect.mapError(
            () =>
              new Identities.IdentityUnavailable({
                operation: "GetEmailIdentity",
                reason: "identity vanished",
              }),
          ),
        ),
      ),
    ),
    Effect.catchTag("IdentityUnavailable", (error) =>
      Effect.orDie(repo.remove(user.userId, domain)).pipe(Effect.andThen(unavailable(error))),
    ),
  );
  const stored = yield* repo
    .setIdentity(user.userId, domain, {
      dkimTokens: identity.dkimTokens,
      dkimZone: DomainVerification.dkimZoneOf(identity),
    })
    .pipe(Effect.orDie);
  yield* Effect.logInfo("custom domain added");
  return view(stored);
});

/**
 * Deletes the SES identity, the caller's aliases on the domain (tombstones included: the
 * domain's next owner controls its mail anyway), then the claim.
 */
const remove = Effect.fn("domains.remove")(function* (requested: string) {
  const domain = yield* owned(requested);
  const identities = yield* Identities.Identities;
  const aliases = yield* AliasRepo.AliasRepo;
  const repo = yield* DomainRepo.DomainRepo;
  yield* identities.delete(domain.domain).pipe(Effect.catchTag("IdentityUnavailable", unavailable));
  yield* Effect.orDie(aliases.releaseDomain(domain.userId, domain.domain));
  yield* repo.remove(domain.userId, domain.domain).pipe(
    Effect.catchTags({
      NoSuchDomain: () => Effect.fail(notFound(requested)),
      DatabaseError: Effect.die,
    }),
  );
});

/** What the domain handlers use. The group captures them once, at startup. */
type DomainServices =
  | Crypto.Crypto
  | DomainRepo.DomainRepo
  | AliasRepo.AliasRepo
  | Identities.Identities
  | Doh.Resolver
  | SharedDomains.SharedDomains;

export const DomainsLive = HttpApiBuilder.group(Api, "domains", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<DomainServices>();
    const repo = yield* DomainRepo.DomainRepo;
    return handlers
      .handle("list", () =>
        Effect.service(CurrentUser).pipe(
          Effect.flatMap((user) => Effect.orDie(repo.listByUser(user.userId))),
          Effect.map(Arr.map(view)),
        ),
      )
      .handle("add", ({ payload }) => Effect.provide(add(payload.domain), services))
      .handle("get", ({ params }) =>
        owned(params.domain).pipe(Effect.map(view), Effect.provide(services)),
      )
      .handle("check", ({ params }) =>
        owned(params.domain).pipe(
          Effect.flatMap((domain) => Effect.orDie(DomainVerification.verifyOnRequest(domain))),
          Effect.flatMap(
            Option.match({
              // Released while checking (expired) or removed concurrently.
              onNone: () => Effect.fail(notFound(params.domain)),
              onSome: (domain) => Effect.succeed(view(domain)),
            }),
          ),
          Effect.provide(services),
        ),
      )
      .handle("update", ({ params, payload }) =>
        Effect.flatMap(Effect.service(CurrentUser), (user) =>
          repo.setCatchAll(user.userId, Str.toLowerCase(params.domain), payload.isCatchAllEnabled),
        ).pipe(
          Effect.map(view),
          Effect.catchTags({
            NoSuchDomain: () => Effect.fail(notFound(params.domain)),
            DatabaseError: Effect.die,
          }),
        ),
      )
      .handle("remove", ({ params }) => Effect.provide(remove(params.domain), services));
  }),
);
