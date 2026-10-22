import { AliasNotFound, ContactNotFound } from "@alias/contracts";
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
