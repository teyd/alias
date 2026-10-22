import { Identities } from "@alias/aws";
import { DomainSetup } from "@alias/dns";
import { DomainRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

/**
 * Checking custom domains (PLAN.md §20.18): the owner's "check now" and the verification cron
 * (`verifyHandler.ts`) both run {@link verify}. A domain is verified when every required DNS
 * record is published (`DomainSetup.verdict`) **and** SES reports its DKIM verified; it fails
 * when a required record goes missing later. Lookups that fail (the resolver, SES) change
 * nothing: a flaky resolver must never take a working domain down.
 */

/** PLAN.md §17: up to three custom domains per user. */
export const MAX_DOMAINS_PER_USER = 3;

/**
 * A pending domain is released after this, so nobody can squat a domain they can't verify. SES
 * also gives up looking for the DKIM records after 72 hours.
 */
export const PENDING_LIFETIME = Duration.hours(72);

/** When the cron looks again, by the status a check left. */
const RECHECK_AFTER = {
  pending: Duration.minutes(10),
  verified: Duration.hours(24),
  failed: Duration.hours(6),
  inconclusive: Duration.minutes(10),
} as const;

/** The owner may ask for a check at most this often; sooner, they get the last result. */
const CHECK_COOLDOWN = Duration.seconds(10);

export const setupOf = (domain: DomainRepo.Domain): DomainSetup.Setup => ({
  domain: domain.domain,
  verificationToken: domain.verificationToken,
  dkimTokens: domain.dkimTokens,
  dkimZone: domain.dkimZone,
});

/** Where the DKIM CNAMEs of an SES identity point. */
export const dkimZoneOf = (identity: Identities.DomainIdentity) =>
  Option.getOrElse(identity.dkimZone, () => DomainSetup.defaultDkimZone);

/** What SES said about the domain's identity, or that it couldn't be asked. */
export type SesState = Result.Result<Option.Option<Identities.DomainIdentity>, "unavailable">;

export type Decision = Data.TaggedEnum<{
  /** Store the check, with this status. */
  Record: {
    readonly status: DomainRepo.DomainStatus;
    readonly verifiedAt: Option.Option<DateTime.Utc>;
    readonly isConclusive: boolean;
  };
  /** A pending domain that ran out of time at `deadline`: release it. */
  Expire: { readonly deadline: DateTime.Utc };
}>;
export const Decision = Data.taggedEnum<Decision>();

/** The new status, from the DNS verdict and SES. Pure. */
export const decide = (
  domain: DomainRepo.Domain,
  verdict: DomainSetup.Verdict,
  ses: SesState,
  now: DateTime.Utc,
): Decision => {
  const dkim = Result.match(ses, {
    onFailure: () => "unknown" as const,
    onSuccess: Option.match({
      onNone: () => "missing" as const,
      onSome: (identity) =>
        identity.dkimStatus === "TEMPORARY_FAILURE"
          ? ("unknown" as const)
          : identity.dkimStatus === "SUCCESS" && identity.isVerifiedForSending
            ? ("verified" as const)
            : ("unverified" as const),
    }),
  });
  if (verdict === "ready" && dkim === "verified") {
    return Decision.Record({
      status: "verified",
      verifiedAt: Option.orElse(domain.verifiedAt, () => Option.some(now)),
      isConclusive: true,
    });
  }
  if (verdict === "inconclusive" || (verdict === "ready" && dkim === "unknown")) {
    return Decision.Record({
      status: domain.status,
      verifiedAt: domain.verifiedAt,
      isConclusive: false,
    });
  }
  if (domain.status === "pending") {
    const deadline = DateTime.addDuration(domain.createdAt, PENDING_LIFETIME);
    return DateTime.isGreaterThanOrEqualTo(now, deadline)
      ? Decision.Expire({ deadline })
      : Decision.Record({ status: "pending", verifiedAt: Option.none(), isConclusive: true });
  }
  return Decision.Record({ status: "failed", verifiedAt: domain.verifiedAt, isConclusive: true });
};

/**
 * The domain's SES identity, created again if it is missing (a claim whose identity creation
 * was interrupted), and its DKIM setup stored if SES changed it.
 */
const identityOf = Effect.fn("DomainVerification.identityOf")(function* (
  domain: DomainRepo.Domain,
) {
  const identities = yield* Identities.Identities;
  const repo = yield* DomainRepo.DomainRepo;
  const found = yield* identities.get(domain.domain);
  const identity = Option.isSome(found)
    ? found.value
    : yield* identities.create(domain.domain, DomainSetup.mailFromDomain(domain.domain)).pipe(
        Effect.catchTag("IdentityExists", () =>
          Effect.flatMap(identities.get(domain.domain), (again) =>
            Effect.fromOption(again).pipe(
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
      );
  const zone = dkimZoneOf(identity);
  const isChanged =
    zone !== domain.dkimZone ||
    Arr.join(identity.dkimTokens, " ") !== Arr.join(domain.dkimTokens, " ");
  const stored = isChanged
    ? yield* repo.setIdentity(domain.userId, domain.domain, {
        dkimTokens: identity.dkimTokens,
        dkimZone: zone,
      })
    : domain;
  return { identity, stored };
});

/**
 * Checks one domain now and stores the result. None when the domain was released (a pending
 * domain past {@link PENDING_LIFETIME}) or removed meanwhile.
 */
export const verify = Effect.fn("DomainVerification.verify")(
  function* (domain: DomainRepo.Domain) {
    const repo = yield* DomainRepo.DomainRepo;
    const identities = yield* Identities.Identities;
    const now = yield* DateTime.now;
    const ses = yield* identityOf(domain).pipe(
      Effect.map((found) =>
        Result.succeed({ found: Option.some(found.identity), stored: found.stored }),
      ),
      Effect.catchTag("IdentityUnavailable", () =>
        Effect.succeed(Result.fail<"unavailable">("unavailable")),
      ),
    );
    const current = Result.match(ses, {
      onFailure: () => domain,
      onSuccess: (found) => found.stored,
    });
    const checks = yield* DomainSetup.check(setupOf(current));
    const decision = decide(
      current,
      DomainSetup.verdict(checks),
      Result.map(ses, (found) => found.found),
      now,
    );
    return yield* Decision.$match(decision, {
      Expire: () =>
        identities.delete(current.domain).pipe(
          Effect.andThen(repo.remove(current.userId, current.domain)),
          Effect.tap(() => Effect.logInfo("domain released: not verified in time")),
          Effect.as(Option.none<DomainRepo.Domain>()),
        ),
      Record: ({ status, verifiedAt, isConclusive }) =>
        repo
          .recordCheck(current.userId, current.domain, {
            status,
            verifiedAt,
            checks: Arr.map(checks, (check) => ({
              type: check.record.type,
              name: check.record.name,
              state: check.state,
            })),
            checkedAt: now,
            nextCheckAt: DateTime.addDuration(
              now,
              isConclusive ? RECHECK_AFTER[status] : RECHECK_AFTER.inconclusive,
            ),
          })
          .pipe(Effect.asSome),
    });
  },
  Effect.catchTag("NoSuchDomain", () => Effect.succeedNone),
);

/** Like {@link verify}, but at most once per {@link CHECK_COOLDOWN}: the owner's button. */
export const verifyOnRequest = Effect.fn("DomainVerification.verifyOnRequest")(function* (
  domain: DomainRepo.Domain,
) {
  const now = yield* DateTime.now;
  const isRecent = Option.exists(domain.checkedAt, (at) =>
    DateTime.isLessThan(now, DateTime.addDuration(at, CHECK_COOLDOWN)),
  );
  return isRecent ? Option.some(domain) : yield* verify(domain);
});

/** How many domains one cron run checks at most; the rest wait for the next run. */
const BATCH = 50;

/** The verification cron: checks every domain that is due, one failure never stopping the rest. */
export const runDue = Effect.fn("DomainVerification.runDue")(function* () {
  const repo = yield* DomainRepo.DomainRepo;
  const due = yield* repo.due(yield* DateTime.now, BATCH);
  const outcomes = yield* Effect.forEach(
    due,
    (domain) =>
      verify(domain).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.as(Effect.logWarning("domain check failed", error._tag), false),
        ),
        Effect.annotateLogs("domain", domain.domain),
      ),
    { concurrency: 2 },
  );
  return {
    checked: Arr.filter(outcomes, (isOk) => isOk).length,
    failed: Arr.filter(outcomes, (isOk) => !isOk).length,
  };
});
