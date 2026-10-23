import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Attribute from "./Attribute.ts";
import { databaseError } from "./DatabaseError.ts";
import type { DynamoTable } from "./Dynamo.ts";

/** A fixed UTC window a quota counts in: the minute, hour or day `now` falls in. */
export interface Window {
  /**
   * Part of the counter's sort key: `2026-10-22T09:41` for a minute, `2026-10-22T09` for an hour,
   * `2026-10-22` for a day.
   */
  readonly label: string;
  readonly end: DateTime.Utc;
  readonly length: Duration.Duration;
}

const UNITS = {
  minute: { length: Duration.minutes(1), label: 16 },
  hour: { length: Duration.hours(1), label: 13 },
  day: { length: Duration.days(1), label: 10 },
} as const;

export const window = (now: DateTime.Utc, unit: keyof typeof UNITS): Window => {
  const start = DateTime.startOf(now, unit);
  const { length, label } = UNITS[unit];
  return {
    label: DateTime.formatIso(start).slice(0, label),
    end: DateTime.addDuration(start, length),
    length,
  };
};

/**
 * Adds one to the counter item at `key` unless it already reached `max`, in one conditional
 * `UpdateItem`, so concurrent callers never exceed it. False when the quota is used up. The item
 * expires (TTL) a window after its own ends; its key names the window, so a late TTL never
 * matters.
 */
export const reserve = Effect.fn("Quota.reserve")(function* (
  table: typeof DynamoTable.Service,
  key: { readonly pk: { readonly S: string }; readonly sk: { readonly S: string } },
  window: Window,
  max: number,
) {
  const expiresAt = yield* Schema.encodeEffect(Attribute.EpochSeconds)(
    DateTime.addDuration(window.end, window.length),
  ).pipe(Effect.mapError(databaseError("EncodeQuota")));
  return yield* DynamoDB.updateItem({
    TableName: table.name,
    Key: key,
    UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, expiresAt = :expiresAt",
    ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
    ExpressionAttributeNames: { "#count": "count" },
    ExpressionAttributeValues: {
      ":zero": { N: "0" },
      ":one": { N: "1" },
      ":max": { N: String(max) },
      ":expiresAt": expiresAt,
    },
  }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => P.isTagged(error, "ConditionalCheckFailedException"),
      () => Effect.succeed(false),
    ),
    Effect.mapError(databaseError("UpdateItem")),
  );
});
