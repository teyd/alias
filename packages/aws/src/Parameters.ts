import * as SSM from "@distilled.cloud/aws/ssm";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** A decrypted `SecureString` parameter. */
interface SecureString {
  readonly value: Redacted.Redacted<string>;
  /** Parameter Store counts up on every `PutParameter --overwrite`. */
  readonly version: number;
}

/** No parameter has this name (`ParameterNotFound`). */
export class MissingParameter extends Schema.TaggedError<MissingParameter>()("MissingParameter", {
  name: Schema.String,
}) {}

/** The parameter couldn't be read now, or isn't a `SecureString`. Never carries its value. */
export class ParameterUnavailable extends Schema.TaggedError<ParameterUnavailable>()(
  "ParameterUnavailable",
  { name: Schema.String, reason: Schema.String },
) {}

/**
 * The `GetParameter` response as the service relies on it. `Value` arrives as a plain string on
 * the wire and as `Redacted` from `@distilled.cloud/aws`, which marks it sensitive.
 * https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_GetParameter.html
 */
export const GetParameterResult = Schema.Struct({
  Parameter: Schema.Struct({
    Type: Schema.Literal("SecureString"),
    Value: Schema.Union([Schema.String, Schema.Redacted(Schema.String)]),
    Version: Schema.Int,
  }),
});
export type GetParameterResult = typeof GetParameterResult.Type;

/**
 * Reads a `SecureString` parameter with `WithDecryption`. A `String` or `StringList` parameter is
 * refused, so a secret stored in plain text by mistake fails loudly instead of being used. No
 * error names the value: decode failures get a fixed reason, not the schema's message.
 */
export const secureString = Effect.fn("Parameters.secureString")(function* (name: string) {
  const response = yield* SSM.getParameter({ Name: name, WithDecryption: true }).pipe(
    Effect.mapError((error) =>
      P.isTagged(error, "ParameterNotFound")
        ? new MissingParameter({ name })
        : new ParameterUnavailable({
            name,
            reason: `${error._tag}: ${String(error.message ?? "")}`,
          }),
    ),
  );
  const { Parameter } = yield* Schema.decodeUnknownEffect(GetParameterResult)(response).pipe(
    Effect.mapError(
      () => new ParameterUnavailable({ name, reason: "not a SecureString with a value" }),
    ),
  );
  const parameter: SecureString = {
    value: Redacted.isRedacted(Parameter.Value) ? Parameter.Value : Redacted.make(Parameter.Value),
    version: Parameter.Version,
  };
  return parameter;
});
