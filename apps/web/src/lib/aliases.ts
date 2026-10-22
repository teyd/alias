import { AliasNotFound, AliasTaken, type AliasView, InvalidAlias } from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { type Client, callApi } from "./api";

/** Why an alias change failed, worded for the person at the keyboard. */
class AliasFailed extends Schema.TaggedError<AliasFailed>()("AliasFailed", {
  message: Schema.String,
}) {}

const aliasProblems = {
  "invalid-address": "That isn't a valid address.",
  "unknown-domain": "Aliases can only live on the domains listed here.",
  "not-your-subdomain": "You can only pick addresses on your own subdomain.",
  "domain-not-verified": "That domain isn't verified. Check its DNS records first.",
  "random-only-on-shared-domain": "Shared domains only get random addresses.",
  "reserved-local-part": "Addresses can't contain “+r.”, replies use it.",
  "role-address": "Role addresses like abuse@ and postmaster@ belong to the service.",
} as const;

const describe = <E>(error: E): string => {
  if (error instanceof InvalidAlias) return aliasProblems[error.reason];
  if (error instanceof AliasTaken) return `${error.address} is already taken.`;
  if (error instanceof AliasNotFound) return "That alias no longer exists.";
  return "Something went wrong. Please try again.";
};

const explain = <A, E>(call: (api: Client) => Effect.Effect<A, E>) =>
  callApi((api) =>
    Effect.mapError(call(api), (error) => new AliasFailed({ message: describe(error) })),
  );

export const aliasesQuery = queryOptions({
  queryKey: ["aliases"],
  queryFn: () => callApi((api) => api.aliases.list()),
});

export const domainsQuery = queryOptions({
  queryKey: ["aliases", "domains"],
  queryFn: () => callApi((api) => api.aliases.domains()),
  staleTime: Infinity,
});

/** A random address on a shared domain, or `local` on one of the caller's subdomains. */
/** What an alias does with mail: forward it, keep it in an inbox (encrypted), or both. */
export type Delivery = AliasView["mode"];

export const createAlias = (input: {
  readonly domain: string;
  readonly local: string;
  readonly mode: Delivery;
}) =>
  explain((api) =>
    Str.isEmpty(input.local)
      ? api.aliases.create({ payload: { _tag: "Random", domain: input.domain, mode: input.mode } })
      : api.aliases.create({
          payload: { _tag: "Address", address: `${input.local}@${input.domain}`, mode: input.mode },
        }),
  );

/** Path parameters for an alias address; local parts never contain `@`. */
export const aliasParams = (address: string) => {
  const at = address.lastIndexOf("@");
  return { local: address.slice(0, at), domain: address.slice(at + 1) };
};

/** An inactive alias keeps its address, but its mail is refused (and counted as blocked). */
export const setActive = (address: string, isActive: boolean) =>
  explain((api) => api.aliases.update({ params: aliasParams(address), payload: { isActive } }));

export const deleteAlias = (address: string) =>
  explain((api) => api.aliases.remove({ params: aliasParams(address) }));
