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
// In the user's partition, so erasing the account sweeps it with everything else.
const loginFailuresKey = (userId: string, hour: string) => ({
  pk: { S: `USER#${userId}` },
  sk: { S: `LOGIN-FAILURES#${hour}` },
});

const CountItem = Item.codec(Schema.Struct({ count: Attribute.N }), "LoginFailures");

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

  return SignupLimitRepo.of({
    reserveChallenge: (source, now, max) =>
      reserve((hour) => challengesKey(source, hour), now, "hour", max),
    reserveSignup: (source, now, max) => reserve((day) => signupsKey(source, day), now, "day", max),
    reserveGlobalSignup: (now, max) => reserve(globalSignupsKey, now, "hour", max),

    loginFailures: Effect.fn("SignupLimitRepo.loginFailures")(function* (userId, now) {
      const result = yield* DynamoDB.getItem({
        TableName: table.name,
        Key: loginFailuresKey(userId, Quota.window(now, "hour").label),
      }).pipe(Effect.mapError(databaseError("GetItem")), Effect.provide(client));
      const counter = yield* CountItem.decodeOption(Option.fromUndefinedOr(result.Item));
      return Option.match(counter, { onNone: () => 0, onSome: ({ count }) => count });
    }),

    recordLoginFailure: (userId, now, max) =>
      reserve((hour) => loginFailuresKey(userId, hour), now, "hour", max).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(SignupLimitRepo, make());
