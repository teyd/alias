import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { databaseError } from "./DatabaseError.ts";

/**
 * Turns an item schema (fields built from `Attribute`) into the two directions a repository
 * needs: domain value → attribute map for writes, attribute map → domain value for reads. Key
 * attributes (`pk`, `sk`, …) are added by the repository and ignored when reading.
 */
export const codec = <A, I extends Readonly<Record<string, DynamoDB.AttributeValue>>>(
  schema: Schema.Codec<A, I>,
  name: string,
) => {
  const encode = Schema.encodeEffect(schema);
  const decode = Schema.decodeUnknownEffect(schema);
  const decodeItem = (item: DynamoDB.AttributeMap) =>
    decode(item).pipe(Effect.mapError(databaseError(`Decode${name}`)));
  return {
    encode: (value: A) => encode(value).pipe(Effect.mapError(databaseError(`Encode${name}`))),
    decode: decodeItem,
    /** None when the read found no item. */
    decodeOption: (item: Option.Option<DynamoDB.AttributeMap>) =>
      Option.match(item, {
        onNone: () => Effect.succeedNone,
        onSome: (present) => Effect.asSome(decodeItem(present)),
      }),
  };
};
