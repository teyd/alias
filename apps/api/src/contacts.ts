import { Api, type Contact, ContactNotFound } from "@alias/contracts";
import { AliasRepo, ContactRepo } from "@alias/db";
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

export const ContactsLive = HttpApiBuilder.group(Api, "contacts", (handlers) =>
  Effect.gen(function* () {
    const aliases = yield* AliasRepo.AliasRepo;
    const contacts = yield* ContactRepo.ContactRepo;
    const owned = (params: { readonly domain: string; readonly local: string }) =>
      ownedAlias(params).pipe(Effect.provideService(AliasRepo.AliasRepo, aliases));
    const missing = (contactId: string) => () => Effect.fail(new ContactNotFound({ contactId }));
    return handlers
      .handle("list", ({ params }) =>
        owned(params).pipe(
          Effect.flatMap((alias) => Effect.orDie(contacts.list(alias.id))),
          Effect.map(Arr.map(view)),
        ),
      )
      .handle("update", ({ params, payload }) =>
        owned(params).pipe(
          Effect.flatMap((alias) =>
            contacts.setBlocked(alias.id, params.contactId, payload.isBlocked),
          ),
          Effect.map(view),
          Effect.catchTags({ NoSuchContact: missing(params.contactId), DatabaseError: Effect.die }),
        ),
      )
      .handle("remove", ({ params }) =>
        owned(params).pipe(
          Effect.flatMap((alias) => contacts.delete(alias.id, params.contactId)),
          Effect.catchTags({ NoSuchContact: missing(params.contactId), DatabaseError: Effect.die }),
        ),
      );
  }),
);
