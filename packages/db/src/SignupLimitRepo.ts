import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";
import * as Quota from "./Quota.ts";

/**
 * The counters that keep sign-up and passkey logins from being run by a script (PLAN.md §20.27).
 * Each `reserve…` adds one to a fixed-window counter unless it already reached `max`, and says
 * whether it did (`Quota.reserve`). `source` is the hashed client address (`ClientSource`).
 */
export class SignupLimitRepo extends Context.Service<
  SignupLimitRepo,
  {
    /** WebAuthn challenges (sign-up and login) issued to one client in a UTC hour. */
    readonly reserveChallenge: (
      source: string,
      now: DateTime.Utc,
      max: number,
    ) => Effect.Effect<boolean, DatabaseError>;
    /** Accounts one client created in a UTC day. */
    readonly reserveSignup: (
      source: string,
      now: DateTime.Utc,
      max: number,
    ) => Effect.Effect<boolean, DatabaseError>;
    /** Accounts everyone created in a UTC hour: the circuit breaker. */
    readonly reserveGlobalSignup: (
      now: DateTime.Utc,
      max: number,
    ) => Effect.Effect<boolean, DatabaseError>;
    /** Failed passkey assertions for one account in the current UTC hour. */
    readonly loginFailures: (
      userId: string,
      now: DateTime.Utc,
    ) => Effect.Effect<number, DatabaseError>;
    /** Counts a failed passkey assertion for the account, up to `max` (the counter stops there). */
    readonly recordLoginFailure: (
      userId: string,
      now: DateTime.Utc,
      max: number,
    ) => Effect.Effect<void, DatabaseError>;
    /** Invite codes from one client that redeemed nothing in the current UTC hour (§20.36). */
    readonly inviteMisses: (
      source: string,
      now: DateTime.Utc,
    ) => Effect.Effect<number, DatabaseError>;
    /** Counts an invite code that redeemed nothing, up to `max` (the counter stops there). */
    readonly recordInviteMiss: (
      source: string,
      now: DateTime.Utc,
      max: number,
    ) => Effect.Effect<void, DatabaseError>;
  }
>()("@alias/db/SignupLimitRepo") {}

const challengesKey = (source: string, hour: string) => ({
  pk: { S: `AUTHLIMIT#${source}` },
  sk: { S: `CHALLENGES#${hour}` },
});
const signupsKey = (source: string, day: string) => ({
  pk: { S: `AUTHLIMIT#${source}` },
  sk: { S: `SIGNUPS#${day}` },
});
const globalSignupsKey = (hour: string) => ({
  pk: { S: "SIGNUPS" },
  sk: { S: `HOUR#${hour}` },
});
const inviteMissesKey = (source: string, hour: string) => ({
  pk: { S: `AUTHLIMIT#${source}` },
  sk: { S: `INVITE-MISSES#${hour}` },
});
// In the user's partition, so erasing the account sweeps it with everything else.
const loginFailuresKey = (userId: string, hour: string) => ({
  pk: { S: `USER#${userId}` },
  sk: { S: `LOGIN-FAILURES#${hour}` },
});

const CountItem = Item.codec(Schema.Struct({ count: Attribute.N }), "SignupCounter");

const make = Effect.fn("SignupLimitRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();

  const reserve = (
    key: (window: string) => Parameters<typeof Quota.reserve>[1],
    now: DateTime.Utc,
    unit: "hour" | "day",
    max: number,
  ) => {
    const window = Quota.window(now, unit);
    return Quota.reserve(table, key(window.label), window, max).pipe(Effect.provide(client));
  };

  /** A counter's value; 0 when nothing was counted in its window yet. */
  const count = Effect.fn("SignupLimitRepo.count")(function* (
    key: Parameters<typeof Quota.reserve>[1],
  ) {
    const result = yield* DynamoDB.getItem({ TableName: table.name, Key: key }).pipe(
      Effect.mapError(databaseError("GetItem")),
      Effect.provide(client),
    );
    const counter = yield* CountItem.decodeOption(Option.fromUndefinedOr(result.Item));
    return Option.match(counter, { onNone: () => 0, onSome: (found) => found.count });
  });

  return SignupLimitRepo.of({
    reserveChallenge: (source, now, max) =>
      reserve((hour) => challengesKey(source, hour), now, "hour", max),
    reserveSignup: (source, now, max) => reserve((day) => signupsKey(source, day), now, "day", max),
    reserveGlobalSignup: (now, max) => reserve(globalSignupsKey, now, "hour", max),

    loginFailures: (userId, now) =>
      count(loginFailuresKey(userId, Quota.window(now, "hour").label)),

    recordLoginFailure: (userId, now, max) =>
      reserve((hour) => loginFailuresKey(userId, hour), now, "hour", max).pipe(Effect.asVoid),

    inviteMisses: (source, now) => count(inviteMissesKey(source, Quota.window(now, "hour").label)),

    recordInviteMiss: (source, now, max) =>
      reserve((hour) => inviteMissesKey(source, hour), now, "hour", max).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(SignupLimitRepo, make());
