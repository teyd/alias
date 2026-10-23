import { AliasNotFound, ContactNotFound, InvalidContact } from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { aliasParams } from "./aliases";
import { type Client, callApi } from "./api";

/** Why a contact action failed, worded for the person at the keyboard. */
class ContactActionFailed extends Schema.TaggedError<ContactActionFailed>()("ContactActionFailed", {
  message: Schema.String,
}) {}

const describe = <E>(error: E): string => {
  if (error instanceof AliasNotFound) return "That alias no longer exists.";
  if (error instanceof ContactNotFound) return "That contact was already removed.";
  if (error instanceof InvalidContact) {
    if (error.reason === "invalid-address") return "That isn't a valid email address.";
    if (error.reason === "blocked-address") {
      return "Your blocklist names that address or its domain. Remove it there first.";
    }
    return "You've added the most new people allowed today. Try again tomorrow.";
  }
  return "Something went wrong. Please try again.";
};

const call = <A, E>(run: (api: Client) => Effect.Effect<A, E>) =>
  callApi((api) =>
    Effect.mapError(run(api), (error) => new ContactActionFailed({ message: describe(error) })),
  );

/** The alias's contacts, oldest first: everyone who wrote to it. */
export const contactsQuery = (aliasAddress: string) =>
  queryOptions({
    queryKey: ["aliases", aliasAddress, "contacts"],
    queryFn: () => call((api) => api.contacts.list({ params: aliasParams(aliasAddress) })),
  });

/** Blocking drops the contact's mail and replies to it; unblocking lets both through again. */
export const setBlocked = (aliasAddress: string, contactId: string, isBlocked: boolean) =>
  call((api) =>
    api.contacts.update({
      params: { ...aliasParams(aliasAddress), contactId },
      payload: { isBlocked },
    }),
  );

/** Removes the contact; its reverse alias stops working for good. */
export const removeContact = (aliasAddress: string, contactId: string) =>
  call((api) => api.contacts.remove({ params: { ...aliasParams(aliasAddress), contactId } }));

/**
 * Adds someone to write to first (PLAN.md §20.33), or finds the contact the alias has, with its
 * reverse alias: mail sent there from a verified destination goes out from the alias.
 */
export const addContact = (aliasAddress: string, address: string) =>
  call((api) => api.contacts.create({ params: aliasParams(aliasAddress), payload: { address } }));
