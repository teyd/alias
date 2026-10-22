import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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
 * What the image proxy keeps (PLAN.md §20.29): fetch budgets per owner and per origin host, and
 * origins that just failed. Every item's partition key starts with `PROXY#`, so the proxy's role
 * can be limited to those (`dynamodb:LeadingKeys`) and touches nothing else in the table.
 */
export class ProxyRepo extends Context.Service<
  ProxyRepo,
  {
    /** Counts one origin fetch for the user whose mail the image came in; false over `max`. */
    readonly reserveOwner: (
      userId: string,
      now: DateTime.Utc,
      max: number,
    ) => Effect.Effect<boolean, DatabaseError>;
    /** Counts one fetch from the origin host; false over `max`. */
    readonly reserveHost: (
      host: string,
      now: DateTime.Utc,
      max: number,
    ) => Effect.Effect<boolean, DatabaseError>;
    /** Until when `host` is left alone after it failed, if that is still ahead. */
    readonly downUntil: (
      host: string,
      now: DateTime.Utc,
    ) => Effect.Effect<Option.Option<DateTime.Utc>, DatabaseError>;
    /** Leaves `host` alone until `until`. */
    readonly markDown: (host: string, until: DateTime.Utc) => Effect.Effect<void, DatabaseError>;
  }
>()("@alias/db/ProxyRepo") {}

const ownerKey = (userId: string, minute: string) => ({
  pk: { S: `PROXY#USER#${userId}` },
  sk: { S: `FETCHES#${minute}` },
});
const hostKey = (host: string, minute: string) => ({
  pk: { S: `PROXY#HOST#${host}` },
  sk: { S: `FETCHES#${minute}` },
});
const downKey = (host: string) => ({
  pk: { S: `PROXY#HOST#${host}` },
  sk: { S: "DOWN" },
});

const DownItem = Item.codec(
  Schema.Struct({ until: Attribute.EpochMillis, expiresAt: Attribute.EpochSeconds }),
  "HostDown",
);

const make = Effect.fn("ProxyRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();
  const TableName = table.name;

  return ProxyRepo.of({
    reserveOwner: (userId, now, max) => {
      const minute = Quota.window(now, "minute");
      return Quota.reserve(table, ownerKey(userId, minute.label), minute, max).pipe(
        Effect.provide(client),
      );
    },

    reserveHost: (host, now, max) => {
      const minute = Quota.window(now, "minute");
      return Quota.reserve(table, hostKey(host, minute.label), minute, max).pipe(
        Effect.provide(client),
      );
    },

    // Eventually consistent: a fetch that starts just after a failure was recorded costs at most
    // one more try.
    downUntil: Effect.fn("ProxyRepo.downUntil")(function* (host, now) {
      const result = yield* DynamoDB.getItem({ TableName, Key: downKey(host) }).pipe(
        Effect.mapError(databaseError("GetItem")),
        Effect.provide(client),
      );
      const down = yield* DownItem.decodeOption(Option.fromUndefinedOr(result.Item));
      // TTL deletes late; an item past its time counts as gone.
      return Option.filter(
        Option.map(down, ({ until }) => until),
        (until) => DateTime.isGreaterThan(until, now),
      );
    }),

    markDown: Effect.fn("ProxyRepo.markDown")(function* (host, until) {
      const attributes = yield* DownItem.encode({ until, expiresAt: until });
      yield* DynamoDB.putItem({
        TableName,
        Item: { ...downKey(host), ...attributes },
      }).pipe(Effect.mapError(databaseError("PutItem")), Effect.provide(client));
    }),
  });
});

export const layer = Layer.effect(ProxyRepo, make());
