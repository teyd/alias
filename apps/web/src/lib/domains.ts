import {
  type Domain,
  DomainNotFound,
  DomainTaken,
  DomainUnavailable,
  InvalidDomain,
  TooManyDomains,
} from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type Client, callApi } from "./api";

/** Why a domain action failed, worded for the person at the keyboard. */
class DomainActionFailed extends Schema.TaggedError<DomainActionFailed>()("DomainActionFailed", {
  message: Schema.String,
}) {}

const describe = <E>(error: E): string => {
  if (error instanceof InvalidDomain) {
    return error.reason === "shared-domain"
      ? "That's one of our own domains. Add a domain you own."
      : "That doesn't look like a domain name.";
  }
  if (error instanceof DomainTaken) return `${error.domain} has already been added.`;
  if (error instanceof TooManyDomains) {
    return `You can add up to ${error.limit} domains. Remove one first.`;
  }
  if (error instanceof DomainNotFound) return "That domain isn't in your account.";
  if (error instanceof DomainUnavailable) return "Can't reach the mail service. Try again shortly.";
  return "Something went wrong. Please try again.";
};

const call = <A, E>(run: (api: Client) => Effect.Effect<A, E>) =>
  callApi((api) =>
    Effect.mapError(run(api), (error) => new DomainActionFailed({ message: describe(error) })),
  );

export type DomainRecord = Domain["records"][number];

/** The user's custom domains, oldest first. Refetched so the cron's checks show up. */
export const customDomainsQuery = queryOptions({
  queryKey: ["domains"],
  queryFn: () => call((api) => api.domains.list()),
  refetchInterval: 60_000,
});

export const addDomain = (domain: string) =>
  call((api) => api.domains.add({ payload: { domain } }));

/** Looks the records up now (at most once per 10 seconds; sooner returns the last result). */
export const checkDomain = (domain: string) =>
  call((api) => api.domains.check({ params: { domain } }));

export const setCatchAll = (domain: string, isCatchAllEnabled: boolean) =>
  call((api) => api.domains.update({ params: { domain }, payload: { isCatchAllEnabled } }));

/** Deletes the domain and every alias on it. */
export const removeDomain = (domain: string) =>
  call((api) => api.domains.remove({ params: { domain } }));
