import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

/** DynamoDB lists one reason per transaction item, in request order. */
const CancellationReasons = Schema.Array(
  Schema.Struct({ Code: Schema.optionalKey(Schema.String) }),
);
const decodeReasons = Schema.decodeUnknownOption(CancellationReasons);

/**
 * True when `error` cancelled a `TransactWriteItems` call because the condition of the item at
 * `index` (request order) failed.
 */
export const conditionFailedAt = <E>(error: E, index: number): boolean =>
  P.isTagged(error, "TransactionCanceledException") &&
  P.hasProperty(error, "CancellationReasons") &&
  Option.exists(decodeReasons(error.CancellationReasons), (reasons) =>
    Option.exists(Arr.get(reasons, index), (reason) => reason.Code === "ConditionalCheckFailed"),
  );
