import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * DynamoDB attribute values as schemas: decoding turns `{ S: "x" }` into `"x"`, so items read from
 * the table are parsed at the boundary instead of trusted.
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
