import { UserCode } from "@alias/core";
import {
  Api,
  CurrentUser,
  DEVICE_CODE_GRANT_TYPE,
  DeviceClientId,
  DeviceClients,
  DeviceCodeNotFound,
  type DeviceRequest,
  OAuthError,
  Scope,
  TOKEN_PREFIX,
  TooManyAttempts,
} from "@alias/contracts";
import { DeviceRepo, type OAuthRepo, TokenRepo, UserRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { MAX_FAILURES_PER_HOUR } from "./Authentication.ts";
import { clientSource } from "./ClientSource.ts";
import { RelyingParty } from "./RelyingParty.ts";
import { hashToken, newToken } from "./Secrets.ts";
import * as Grants from "./oauth/Grants.ts";
import { mint } from "./tokens.ts";

/** RFC 8628 §3.2 leaves the lifetime open; 10 minutes is enough to switch to a browser. */
const DEVICE_CODE_LIFETIME = Duration.minutes(10);
/** The polling interval a device starts with (RFC 8628's default). */
const POLL_SECONDS = 5;
/** A device login's token lives this long; `alias login` again renews it. */
export const DEVICE_TOKEN_DAYS = 90;
/** Device authorization requests one client address may make in an hour. */
export const MAX_DEVICE_REQUESTS_PER_HOUR = 20;
/** Unknown user codes a signed-in user may try in an hour (RFC 8628 §5.1). */
export const MAX_CODE_MISSES_PER_HOUR = 10;

const oauthError = (error: OAuthError["error"], description?: string) =>
  Effect.fail(
    new OAuthError(P.isString(description) ? { error, error_description: description } : { error }),
  );

/** RFC 6749 §5.1: token endpoint responses, failures included, must not be cached. */
const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
);

const knownClient: (clientId: string) => Option.Option<DeviceClientId> = Option.liftPredicate(
  Schema.is(DeviceClientId),
);

/** `scope`, space-separated (RFC 6749 §3.3): only known scopes, at least one. */
const parseScopes = (scope: string): Option.Option<ReadonlyArray<Scope>> => {
  const requested = Arr.filter(Str.split(scope, " "), Str.isNonEmpty);
  const known = Arr.filter(requested, Schema.is(Scope));
  return Arr.isArrayNonEmpty(known) && known.length === requested.length
    ? Option.some(Arr.dedupe(known))
    : Option.none();
};

/** Draws user codes until one isn't taken (collisions are rare: 20⁸ codes, few live at once). */
const createGrant = Effect.fn("device.createGrant")(function* (
  fields: Omit<DeviceRepo.DeviceGrant, "userCode">,
) {
  const crypto = yield* Crypto.Crypto;
  const devices = yield* DeviceRepo.DeviceRepo;
  const draw = Effect.flatMap(Effect.orDie(crypto.randomBytes(16)), (bytes) =>
    Option.match(UserCode.fromBytes(bytes), {
      onNone: () => Effect.fail(new DeviceRepo.UserCodeTaken()),
      onSome: (userCode) => Effect.as(devices.create({ ...fields, userCode }), userCode),
    }),
  );
  return yield* draw.pipe(
    Effect.retry({ times: 5, while: (error) => P.isTagged(error, "UserCodeTaken") }),
    Effect.orDie,
  );
});

const deviceAuthorization = Effect.fn("device.deviceAuthorization")(function* (payload: {
  readonly client_id: string;
  readonly scope: string;
}) {
  yield* noStore;
  if (Option.isNone(knownClient(payload.client_id))) {
    return yield* oauthError("invalid_client", "Unknown client_id.");
  }
  const scopes = parseScopes(payload.scope);
  if (Option.isNone(scopes)) return yield* oauthError("invalid_scope");
  const devices = yield* DeviceRepo.DeviceRepo;
  const now = yield* DateTime.now;
  const source = yield* clientSource();
  if (!(yield* Effect.orDie(devices.reserveRequest(source, now, MAX_DEVICE_REQUESTS_PER_HOUR)))) {
    return yield* new TooManyAttempts();
  }
  const crypto = yield* Crypto.Crypto;
  const deviceCode = yield* Effect.orDie(newToken(crypto));
  const userCode = yield* createGrant({
    deviceHash: yield* Effect.orDie(hashToken(crypto, deviceCode)),
    clientId: payload.client_id,
    scopes: scopes.value,
    createdAt: now,
    expiresAt: DateTime.addDuration(now, DEVICE_CODE_LIFETIME),
    pollSeconds: POLL_SECONDS,
    nextPollAt: now,
    decision: DeviceRepo.Pending(),
  });
  const { origin } = yield* RelyingParty;
  const shown = UserCode.format(userCode);
  return {
    device_code: deviceCode,
    user_code: shown,
    verification_uri: `${origin}/device`,
    verification_uri_complete: `${origin}/device?code=${shown}`,
    expires_in: Duration.toSeconds(DEVICE_CODE_LIFETIME),
    interval: POLL_SECONDS,
  };
});

/** The approved grant's token, issued once; the grant is gone afterwards. */
const issue = Effect.fn("device.issue")(function* (
  grant: DeviceRepo.DeviceGrant,
  user: { readonly userId: string; readonly username: string },
) {
  const devices = yield* DeviceRepo.DeviceRepo;
  const users = yield* UserRepo.UserRepo;
  // Erased since approving: nothing to issue a token for.
  if (Option.isNone(yield* Effect.orDie(users.findById(user.userId)))) {
    yield* Effect.orDie(devices.remove(grant));
    return yield* oauthError("access_denied");
  }
  const clientName = Option.getOrElse(
    Option.map(knownClient(grant.clientId), (id) => DeviceClients[id]),
    () => grant.clientId,
  );
  const scopes = Arr.filter(grant.scopes, Schema.is(Scope));
  const { token, secret } = yield* Effect.orDie(
    mint(user, {
      name: `${clientName} (device login)`,
      scopes,
      expiresInDays: DEVICE_TOKEN_DAYS,
    }),
  );
  yield* devices.redeem(grant, token).pipe(
    Effect.catchTags({
      GrantRedeemed: () => oauthError("invalid_grant", "The device code was already used."),
      DatabaseError: Effect.die,
    }),
  );
  return {
    access_token: secret,
    token_type: "Bearer" as const,
    expires_in: DEVICE_TOKEN_DAYS * 24 * 60 * 60,
    scope: Arr.join(scopes, " "),
  };
});

/**
 * An MCP client's grant (PLAN.md §20.24). Failed exchanges count against the address with the
 * same counter as device codes and API tokens, so codes and refresh tokens can't be guessed at
 * volume either.
 */
const mcpToken = Effect.fn("device.mcpToken")(function* (payload: Grants.TokenRequest) {
  const tokens = yield* TokenRepo.TokenRepo;
  const now = yield* DateTime.now;
  const source = yield* clientSource();
  if ((yield* Effect.orDie(tokens.failures(source, now))) >= MAX_FAILURES_PER_HOUR) {
    return yield* new TooManyAttempts();
  }
  return yield* Grants.exchange(payload).pipe(
    Effect.tapError((error) =>
      error.error === "invalid_grant"
        ? Effect.orDie(tokens.recordFailure(source, now, MAX_FAILURES_PER_HOUR))
        : Effect.void,
    ),
  );
});

const token = Effect.fn("device.token")(function* (payload: Grants.TokenRequest) {
  yield* noStore;
  if (Arr.contains(Grants.GRANT_TYPES, payload.grant_type)) return yield* mcpToken(payload);
  if (payload.grant_type !== DEVICE_CODE_GRANT_TYPE) {
    return yield* oauthError("unsupported_grant_type");
  }
  const deviceCode = Option.fromUndefinedOr(payload.device_code);
  if (Option.isNone(deviceCode))
    return yield* oauthError("invalid_request", "Missing device_code.");
  if (Option.isNone(knownClient(payload.client_id))) return yield* oauthError("invalid_client");
  // Device codes are bearer secrets like tokens: unknown ones count as failed attempts.
  const tokens = yield* TokenRepo.TokenRepo;
  const now = yield* DateTime.now;
  const source = yield* clientSource();
  if ((yield* Effect.orDie(tokens.failures(source, now))) >= MAX_FAILURES_PER_HOUR) {
    return yield* new TooManyAttempts();
  }
  const crypto = yield* Crypto.Crypto;
  const devices = yield* DeviceRepo.DeviceRepo;
  const polled = yield* Effect.orDie(
    Effect.flatMap(hashToken(crypto, deviceCode.value), devices.poll),
  );
  if (Option.isNone(polled) || polled.value.grant.clientId !== payload.client_id) {
    yield* Effect.orDie(tokens.recordFailure(source, now, MAX_FAILURES_PER_HOUR));
    return yield* oauthError("invalid_grant");
  }
  const { grant, isTooSoon } = polled.value;
  if (!DateTime.isGreaterThan(grant.expiresAt, now)) return yield* oauthError("expired_token");
  if (isTooSoon) return yield* oauthError("slow_down");
  return yield* DeviceRepo.matchDecision(grant.decision, {
    Pending: () => oauthError("authorization_pending"),
    Denied: () => Effect.andThen(Effect.orDie(devices.remove(grant)), oauthError("access_denied")),
    Approved: (user) => issue(grant, user),
  });
});

/**
 * RFC 7009: the holder revokes its token, a device login's API token or an MCP client's
 * (`Grants.revoke`). Unknown and malformed tokens are fine too.
 */
const revoke = Effect.fn("device.revoke")(function* (payload: {
  readonly token: string;
  readonly client_id?: string;
}) {
  yield* noStore;
  if (Grants.isOAuthToken(payload.token))
    return yield* Grants.revoke(payload.token, Option.fromUndefinedOr(payload.client_id));
  if (!Str.startsWith(TOKEN_PREFIX)(payload.token)) return;
  const crypto = yield* Crypto.Crypto;
  const tokens = yield* TokenRepo.TokenRepo;
  yield* Effect.orDie(Effect.flatMap(hashToken(crypto, payload.token), tokens.revokeByHash));
});

/** The pending grant behind a typed code, counting unknown codes against the signed-in user. */
const findPending = Effect.fn("device.findPending")(function* (typed: string) {
  const user = yield* CurrentUser;
  const devices = yield* DeviceRepo.DeviceRepo;
  const now = yield* DateTime.now;
  if ((yield* Effect.orDie(devices.misses(user.userId, now))) >= MAX_CODE_MISSES_PER_HOUR) {
    return yield* new TooManyAttempts();
  }
  const found = yield* Option.match(UserCode.normalize(typed), {
    onNone: () => Effect.succeedNone,
    onSome: (code) => Effect.orDie(devices.findByUserCode(code)),
  });
  const pending = Option.filter(found, (grant) =>
    DeviceRepo.matchDecision(grant.decision, {
      Pending: () => true,
      Approved: () => false,
      Denied: () => false,
    }),
  );
  if (Option.isNone(pending)) {
    yield* Effect.orDie(devices.recordMiss(user.userId, now, MAX_CODE_MISSES_PER_HOUR));
    return yield* new DeviceCodeNotFound();
  }
  return pending.value;
});

const view = (grant: DeviceRepo.DeviceGrant): DeviceRequest => ({
  userCode: UserCode.format(grant.userCode),
  clientId: grant.clientId,
  clientName: Option.getOrElse(
    Option.map(knownClient(grant.clientId), (id) => DeviceClients[id]),
    () => grant.clientId,
  ),
  scopes: Arr.filter(grant.scopes, Schema.is(Scope)),
  createdAt: grant.createdAt,
  expiresAt: grant.expiresAt,
});

const decide = Effect.fn("device.decide")(function* (typed: string, isApproved: boolean) {
  const user = yield* CurrentUser;
  const grant = yield* findPending(typed);
  const devices = yield* DeviceRepo.DeviceRepo;
  yield* devices
    .decide(
      grant.userCode,
      isApproved
        ? DeviceRepo.Approved({ userId: user.userId, username: user.username })
        : DeviceRepo.Denied(),
    )
    .pipe(
      Effect.catchTags({
        NoSuchDeviceGrant: () => Effect.fail(new DeviceCodeNotFound()),
        DatabaseError: Effect.die,
      }),
    );
});

/** What the device handlers use. The groups capture them once, at startup. */
type DeviceServices =
  | Crypto.Crypto
  | OAuthRepo.OAuthRepo
  | DeviceRepo.DeviceRepo
  | TokenRepo.TokenRepo
  | UserRepo.UserRepo
  | RelyingParty;

export const OAuthLive = HttpApiBuilder.group(Api, "oauth", (handlers) =>
  Effect.map(Effect.context<DeviceServices>(), (services) =>
    handlers
      .handle("deviceAuthorization", ({ payload }) =>
        Effect.provide(deviceAuthorization(payload), services),
      )
      .handle("token", ({ payload }) => Effect.provide(token(payload), services))
      .handle("revoke", ({ payload }) => Effect.provide(revoke(payload), services)),
  ),
);

export const DeviceLive = HttpApiBuilder.group(Api, "device", (handlers) =>
  Effect.map(Effect.context<DeviceServices>(), (services) =>
    handlers
      .handle("lookup", ({ payload }) =>
        Effect.provide(Effect.map(findPending(payload.userCode), view), services),
      )
      .handle("approve", ({ payload }) => Effect.provide(decide(payload.userCode, true), services))
      .handle("deny", ({ payload }) => Effect.provide(decide(payload.userCode, false), services)),
  ),
);
