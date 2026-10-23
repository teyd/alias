import { ReverseKeys } from "@alias/aws";
import {
  type AddedContact,
  AliasNotFound,
  Api,
  type Contact,
  ContactNotFound,
  InvalidContact,
} from "@alias/contracts";
import { Address, Blocklist, ReverseToken } from "@alias/core";
import { type AliasRepo, ContactRepo, FilterRepo, OutboxRepo } from "@alias/db";
import * as Arr from "effect/Array";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import { HttpApiBuilder } from "effect/http-api";
import * as Option from "effect/Option";
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

/**
 * Whether the owner's blocklist (PLAN.md §20.32) names `address` or its domain. The owner blocked
 * mail from it and replies to it; mail they write to it is refused too (PLAN.md §20.33).
 */
export const isBlocklisted = Effect.fn("contacts.isBlocklisted")(function* (
  userId: string,
  address: string,
) {
  const filters = yield* Effect.orDie((yield* FilterRepo.FilterRepo).find(userId));
  return Option.isSome(Blocklist.match(HashSet.fromIterable(filters.blocklist), address));
});

/**
 * The alias's contact for `given`, added if the alias has none (PLAN.md §20.33): the owner writes
 * to someone first. A new one spends one of the owner's new recipients for the day, an existing
 * one (blocked or not) nothing. An address the owner's blocklist names is refused.
 */
export const ensure = Effect.fn("contacts.ensure")(function* (
  alias: AliasRepo.Alias,
  given: string,
) {
  const parsed = yield* Address.parse(given).pipe(
    Effect.mapError(() => new InvalidContact({ reason: "invalid-address" })),
  );
  const address = Address.format(parsed);
  if (yield* isBlocklisted(alias.userId, address)) {
    return yield* new InvalidContact({ reason: "blocked-address" });
  }
  const contacts = yield* ContactRepo.ContactRepo;
  const known = yield* Effect.orDie(contacts.findByAddress(alias.id, address));
  if (Option.isSome(known)) return known.value;
  const now = yield* DateTime.now;
  const outbox = yield* OutboxRepo.OutboxRepo;
  const isAllowed = yield* Effect.orDie(
    outbox.reserveRecipient(alias.userId, now, OutboxRepo.NEW_RECIPIENTS_PER_DAY),
  );
  if (!isAllowed) return yield* new InvalidContact({ reason: "recipient-limit" });
  const created: ContactRepo.Contact = {
    id: yield* Effect.orDie(ReverseToken.newContactId()),
    aliasId: alias.id,
    address,
    name: Option.none(),
    createdAt: now,
    isBlocked: false,
  };
  return yield* contacts.create(created, alias).pipe(
    Effect.as(created),
    Effect.catchTags({
      // Someone wrote to the alias meanwhile, or a second tab added it too.
      ContactExists: () =>
        Effect.flatMap(Effect.orDie(contacts.findByAddress(alias.id, address)), (found) =>
          Effect.succeed(Option.getOrElse(found, () => created)),
        ),
      NoSuchAlias: () =>
        Effect.fail(new AliasNotFound({ address: `${alias.localPart}@${alias.domain}` })),
      DatabaseError: Effect.die,
    }),
  );
});

/**
 * Adds a contact to the caller's alias (or finds the one it has) and returns it with its reverse
 * alias: mail the owner sends there from a verified forwarding address goes out as the alias,
 * through the reply path's checks (PLAN.md §20.6, §20.33).
 */
const create = Effect.fn("contacts.create")(function* (params: AliasParams, address: string) {
  const alias = yield* ownedAlias(params);
  const contact = yield* ensure(alias, address);
  const aliasAddress = { local: alias.localPart, domain: alias.domain };
  // A contact id from `newContactId` always fits a token on an address the alias already has.
  const token = yield* Effect.orDie(
    ReverseToken.mint(yield* ReverseKeys.ReverseKeys, aliasAddress, contact.id),
  );
  const added: AddedContact = {
    ...view(contact),
    replyAddress: Address.format(Address.reverseAddress(aliasAddress, token)),
  };
  return added;
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
type ContactServices =
  | AliasRepo.AliasRepo
  | ContactRepo.ContactRepo
  | OutboxRepo.OutboxRepo
  | FilterRepo.FilterRepo
  | ReverseKeys.ReverseKeys
  | Crypto.Crypto;

export const ContactsLive = HttpApiBuilder.group(Api, "contacts", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<ContactServices>();
    const contacts = yield* ContactRepo.ContactRepo;
    return handlers
      .handle("list", ({ params }) => Effect.provide(list(params), services))
      .handle("create", ({ params, payload }) =>
        Effect.provide(create(params, payload.address), services),
      )
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
