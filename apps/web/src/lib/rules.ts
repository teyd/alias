import {
  BlocklistEntryNotFound,
  BlocklistFull,
  InvalidBlocklistEntry,
  InvalidRuleOrder,
  RuleNotFound,
  TooManyRules,
  UnknownRecipient,
} from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type Client, callApi } from "./api";

/** Why a blocklist or rules action failed, worded for the person at the keyboard. */
class RulesActionFailed extends Schema.TaggedError<RulesActionFailed>()("RulesActionFailed", {
  message: Schema.String,
}) {}

const describe = <E>(error: E): string => {
  if (error instanceof InvalidBlocklistEntry) {
    return error.reason === "invalid-address"
      ? "That isn't an address like name@shop.example."
      : "That isn't a domain like shop.example.";
  }
  if (error instanceof BlocklistFull) return `You can block up to ${error.limit} senders.`;
  if (error instanceof BlocklistEntryNotFound) return "That sender isn't blocked any more.";
  if (error instanceof TooManyRules) return `You can have up to ${error.limit} rules.`;
  if (error instanceof RuleNotFound) return "That rule was already deleted.";
  if (error instanceof UnknownRecipient) return "Pick one of your destinations.";
  if (error instanceof InvalidRuleOrder)
    return "The rules changed meanwhile. Reload and try again.";
  return "Something went wrong. Please try again.";
};

/** Runs one blocklist or rules call, replacing every failure with a readable message. */
export const callRules = <A, E>(call: (api: Client) => Effect.Effect<A, E>): Promise<A> =>
  callApi((api) =>
    Effect.mapError(call(api), (error) => new RulesActionFailed({ message: describe(error) })),
  );

export const blocklistQuery = queryOptions({
  queryKey: ["blocklist"],
  queryFn: () => callRules((api) => api.blocklist.list()),
});

export const rulesQuery = queryOptions({
  queryKey: ["rules"],
  queryFn: () => callRules((api) => api.rules.list()),
});

/** Blocks an address (anything with an `@`) or a domain on every alias. */
export const blockSender = (sender: string, isSubdomainIncluded: boolean) =>
  callRules((api) =>
    api.blocklist.add({
      payload: {
        kind: sender.includes("@") ? "address" : "domain",
        value: sender,
        isSubdomainIncluded,
      },
    }),
  );
