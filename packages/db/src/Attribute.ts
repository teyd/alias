import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * DynamoDB attribute values as schemas. Decoding turns `{ S: "x" }` into `"x"`, so repositories
 * parse the items they read from the table at the boundary instead of trusting them.
 */
export const S = Schema.Struct({ S: Schema.String }).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (attribute) => attribute.S,
      encode: (value) => ({ S: value }),
    }),
  ),
);

export type S = typeof S.Type;

export const N = Schema.Struct({ N: Schema.FiniteFromString }).pipe(
  Schema.decodeTo(
    Schema.Finite,
    SchemaTransformation.transform({
      decode: (attribute) => attribute.N,
      encode: (value) => ({ N: value }),
    }),
  ),
);

export type N = typeof N.Type;

// `BOOL` is DynamoDB's wire name, not ours to choose.
// oxlint-disable-next-line effect/require-is-prefix-for-boolean-schema-field
export const BOOL = Schema.Struct({ BOOL: Schema.Boolean }).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (attribute) => attribute.BOOL,
      encode: (value) => ({ BOOL: value }),
    }),
  ),
);
export type BOOL = typeof BOOL.Type;

export const B = Schema.Struct({ B: Schema.Uint8Array }).pipe(
  Schema.decodeTo(
    Schema.Uint8Array,
    SchemaTransformation.transform({
      decode: (attribute) => attribute.B,
      encode: (value) => ({ B: value }),
    }),
  ),
);
export type B = typeof B.Type;

/** A list of strings (`L` of `S`). Unlike a string set (`SS`), it may be empty. */
export const StringList = Schema.Struct({ L: Schema.mutable(Schema.Array(S)) }).pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transform({
      decode: (attribute): ReadonlyArray<string> => attribute.L,
      encode: (values: ReadonlyArray<string>) => ({ L: [...values] }),
    }),
  ),
);
export type StringList = typeof StringList.Type;

/** A string set (`SS`). DynamoDB never stores an empty set: no attribute means none. */
export const StringSet = Schema.Struct({ SS: Schema.mutable(Schema.Array(Schema.String)) }).pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transform({
      decode: (attribute): ReadonlyArray<string> => attribute.SS,
      encode: (values: ReadonlyArray<string>) => ({ SS: [...values] }),
    }),
  ),
);
export type StringSet = typeof StringSet.Type;

/** An `N` holding epoch milliseconds, as a `DateTime.Utc`. */
export const EpochMillis = N.pipe(
  Schema.decodeTo(
    Schema.DateTimeUtc,
    SchemaTransformation.transform({
      decode: (millis) => DateTime.makeUnsafe(millis),
      encode: (dateTime) => DateTime.toEpochMillis(dateTime),
    }),
  ),
);

/** An `N` holding epoch seconds, the unit DynamoDB TTL reads (`expiresAt`), as a `DateTime.Utc`. */
export const EpochSeconds = N.pipe(
  Schema.decodeTo(
    Schema.DateTimeUtc,
    SchemaTransformation.transform({
      decode: (seconds) => DateTime.makeUnsafe(seconds * 1000),
      encode: (dateTime) => Math.ceil(DateTime.toEpochMillis(dateTime) / 1000),
    }),
  ),
);
