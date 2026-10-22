import { Api, type Contact, ContactNotFound } from "@alias/contracts";
import { type AliasRepo, ContactRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";
import { ownedAlias } from "./aliases.ts";

const view = (contact: ContactRepo.Contact): Contact => ({
  id: contact.id,
  address: contact.address,
  name: contact.name,
  isBlocked: contact.isBlocked,
  createdAt: contact.createdAt,
});

interface AliasParams {
  readonly domain: string;
  readonly local: string;
}

const missing = (contactId: string) => () => Effect.fail(new ContactNotFound({ contactId }));

/** The contacts of the caller's alias. */
export const list = Effect.fn("contacts.list")(function* (params: AliasParams) {
  const alias = yield* ownedAlias(params);
  const contacts = yield* ContactRepo.ContactRepo;
  return Arr.map(yield* Effect.orDie(contacts.list(alias.id)), view);
});

/** Blocks or unblocks a contact of the caller's alias. */
export const setBlocked = Effect.fn("contacts.setBlocked")(function* (
  params: AliasParams,
  contactId: string,
  isBlocked: boolean,
) {
  const alias = yield* ownedAlias(params);
  const contacts = yield* ContactRepo.ContactRepo;
  const contact = yield* contacts
    .setBlocked(alias.id, contactId, isBlocked)
    .pipe(Effect.catchTags({ NoSuchContact: missing(contactId), DatabaseError: Effect.die }));
  return view(contact);
});

/** What the contact handlers use. The group captures them once, at startup. */
type ContactServices = AliasRepo.AliasRepo | ContactRepo.ContactRepo;

export const ContactsLive = HttpApiBuilder.group(Api, "contacts", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<ContactServices>();
    const contacts = yield* ContactRepo.ContactRepo;
    return handlers
      .handle("list", ({ params }) => Effect.provide(list(params), services))
      .handle("update", ({ params, payload }) =>
        Effect.provide(setBlocked(params, params.contactId, payload.isBlocked), services),
      )
      .handle("remove", ({ params }) =>
        ownedAlias(params).pipe(
          Effect.flatMap((alias) => contacts.delete(alias.id, params.contactId)),
          Effect.catchTags({ NoSuchContact: missing(params.contactId), DatabaseError: Effect.die }),
          Effect.provide(services),
        ),
      );
  }),
);
