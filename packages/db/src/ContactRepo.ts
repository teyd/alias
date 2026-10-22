import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { NoSuchAlias } from "./AliasRepo.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";
import { aliasKey, contactsPartition } from "./Keys.ts";
import { conditionFailedAt } from "./Transaction.ts";

/**
 * Someone who wrote to an alias (PLAN.md §3.1): the reverse alias the owner replies through
 * names the contact by its id, so blocking or deleting the contact revokes it.
 */
export interface Contact {
  /** Short and random (`ReverseToken.newContactId`); carried in reverse-alias tokens. */
  readonly id: string;
  /** The alias the contact wrote to, by id, so a later alias at the same address starts empty. */
  readonly aliasId: string;
  /** The sender's address as it first wrote, which is where replies go. */
  readonly address: string;
  /** The display name it first wrote with. */
  readonly name: Option.Option<string>;
  readonly createdAt: DateTime.Utc;
  /** Mail from a blocked contact is dropped, and replies to it are too. */
  readonly isBlocked: boolean;
}

export type NewContact = Omit<Contact, "isBlocked">;

/** Where the contact's alias lives. */
interface AliasAddress {
  readonly domain: string;
  readonly localPart: string;
}

/** The alias already has a contact for this address (a concurrent first message, say). */
export class ContactExists extends Schema.TaggedError<ContactExists>()("ContactExists", {
  address: Schema.String,
}) {}

/** No contact with this id on this alias. */
export class NoSuchContact extends Schema.TaggedError<NoSuchContact>()("NoSuchContact", {
  contactId: Schema.String,
}) {}

export class ContactRepo extends Context.Service<
  ContactRepo,
  {
    /**
     * Stores a new, unblocked contact of the alias at `alias` (whose id is `contact.aliasId`).
     * Addresses match case-insensitively. Fails with `NoSuchAlias` once that alias is deleted, so
     * no contact outlives the purge of its alias (`AliasRepo.delete`).
     */
    readonly create: (
      contact: NewContact,
      alias: AliasAddress,
    ) => Effect.Effect<void, ContactExists | NoSuchAlias | DatabaseError>;
    readonly findByAddress: (
      aliasId: string,
      address: string,
    ) => Effect.Effect<Option.Option<Contact>, DatabaseError>;
    readonly findById: (
      aliasId: string,
      contactId: string,
    ) => Effect.Effect<Option.Option<Contact>, DatabaseError>;
    /** Oldest first. */
    readonly list: (aliasId: string) => Effect.Effect<ReadonlyArray<Contact>, DatabaseError>;
    /** Blocks or unblocks, and returns the contact as stored afterwards. */
    readonly setBlocked: (
      aliasId: string,
      contactId: string,
      isBlocked: boolean,
    ) => Effect.Effect<Contact, NoSuchContact | DatabaseError>;
    /** Removes the contact; its reverse aliases stop working. */
    readonly delete: (
      aliasId: string,
      contactId: string,
    ) => Effect.Effect<void, NoSuchContact | DatabaseError>;
  }
>()("@alias/db/ContactRepo") {}

const partition = (aliasId: string) => ({ S: contactsPartition(aliasId) });

/** The contact itself, found by sender address on every forwarded message. */
const addressKey = (aliasId: string, address: string) => ({
  pk: partition(aliasId),
  sk: { S: `CONTACT#${address.toLowerCase()}` },
});

/** Points from a contact id (a reply's token) to the contact's address. */
const idKey = (aliasId: string, contactId: string) => ({
  pk: partition(aliasId),
  sk: { S: `CONTACT-ID#${contactId}` },
});

const ContactItem = Item.codec(
  Schema.Struct({
    id: Attribute.S,
    aliasId: Attribute.S,
    address: Attribute.S,
    name: Schema.OptionFromOptionalKey(Attribute.S),
    createdAt: Attribute.EpochMillis,
    isBlocked: Attribute.BOOL,
  }),
  "Contact",
);

const PointerItem = Item.codec(Schema.Struct({ address: Attribute.S }), "ContactId");

const oldestFirst = Order.mapInput(DateTime.Order, (contact: Contact) => contact.createdAt);

const make = Effect.fn("ContactRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();
  const TableName = table.name;

  const findByAddress = (aliasId: string, address: string) =>
    DynamoDB.getItem({ TableName, Key: addressKey(aliasId, address), ConsistentRead: true }).pipe(
      Effect.mapError(databaseError("GetItem")),
      Effect.flatMap((result) => ContactItem.decodeOption(Option.fromUndefinedOr(result.Item))),
      Effect.provide(client),
    );

  const findById = Effect.fn("ContactRepo.findById")(function* (
    aliasId: string,
    contactId: string,
  ) {
    const pointer = yield* DynamoDB.getItem({
      TableName,
      Key: idKey(aliasId, contactId),
      ConsistentRead: true,
    }).pipe(
      Effect.mapError(databaseError("GetItem")),
      Effect.flatMap((result) => PointerItem.decodeOption(Option.fromUndefinedOr(result.Item))),
      Effect.provide(client),
    );
    if (Option.isNone(pointer)) return Option.none<Contact>();
    // A pointer left from a contact deleted and recreated meanwhile names a different id.
    return Option.filter(
      yield* findByAddress(aliasId, pointer.value.address),
      (contact) => contact.id === contactId,
    );
  });

  const requireById = (aliasId: string, contactId: string) =>
    Effect.flatMap(findById(aliasId, contactId), (found) =>
      Option.match(found, {
        onNone: () => Effect.fail(new NoSuchContact({ contactId })),
        onSome: Effect.succeed,
      }),
    );

  const missingOn =
    (operation: string, contactId: string) =>
    <E>(error: E) =>
      P.isTagged(error, "ConditionalCheckFailedException") || conditionFailedAt(error, 0)
        ? new NoSuchContact({ contactId })
        : databaseError(operation)(error);

  return ContactRepo.of({
    create: Effect.fn("ContactRepo.create")(function* (contact, alias) {
      const attributes = yield* ContactItem.encode({ ...contact, isBlocked: false });
      const pointer = yield* PointerItem.encode({ address: contact.address.toLowerCase() });
      yield* DynamoDB.transactWriteItems({
        TransactItems: [
          {
            Put: {
              TableName,
              Item: { ...addressKey(contact.aliasId, contact.address), ...attributes },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName,
              Item: { ...idKey(contact.aliasId, contact.id), ...pointer },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            // The live alias has this id; its tombstone has none or keeps it marked deleted.
            ConditionCheck: {
              TableName,
              Key: aliasKey(alias.domain, alias.localPart),
              ConditionExpression: "#id = :aliasId AND attribute_not_exists(deletedAt)",
              ExpressionAttributeNames: { "#id": "id" },
              ExpressionAttributeValues: { ":aliasId": { S: contact.aliasId } },
            },
          },
        ],
      }).pipe(
        Effect.mapError((error) => {
          if (conditionFailedAt(error, 0)) return new ContactExists({ address: contact.address });
          if (conditionFailedAt(error, 2)) {
            return new NoSuchAlias({
              address: `${alias.localPart}@${alias.domain}`.toLowerCase(),
            });
          }
          return databaseError("TransactWriteItems")(error);
        }),
        Effect.provide(client),
      );
    }),

    findByAddress,
    findById: (aliasId, contactId) => findById(aliasId, contactId),

    list: (aliasId) =>
      DynamoDB.query
        .items({
          TableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": partition(aliasId), ":prefix": { S: "CONTACT#" } },
          ConsistentRead: true,
        })
        .pipe(
          Stream.mapError(databaseError("Query")),
          Stream.mapEffect(ContactItem.decode),
          Stream.runCollect,
          Effect.map((contacts) => Arr.sort(contacts, oldestFirst)),
          Effect.provide(client),
        ),

    setBlocked: Effect.fn("ContactRepo.setBlocked")(function* (aliasId, contactId, isBlocked) {
      const contact = yield* requireById(aliasId, contactId);
      const result = yield* DynamoDB.updateItem({
        TableName,
        Key: addressKey(aliasId, contact.address),
        UpdateExpression: "SET isBlocked = :isBlocked",
        ConditionExpression: "#id = :id",
        ExpressionAttributeNames: { "#id": "id" },
        ExpressionAttributeValues: { ":id": { S: contactId }, ":isBlocked": { BOOL: isBlocked } },
        ReturnValues: "ALL_NEW",
      }).pipe(Effect.mapError(missingOn("UpdateItem", contactId)), Effect.provide(client));
      return yield* ContactItem.decode({ ...result.Attributes });
    }),

    delete: Effect.fn("ContactRepo.delete")(function* (aliasId, contactId) {
      const contact = yield* requireById(aliasId, contactId);
      yield* DynamoDB.transactWriteItems({
        TransactItems: [
          {
            Delete: {
              TableName,
              Key: addressKey(aliasId, contact.address),
              ConditionExpression: "#id = :id",
              ExpressionAttributeNames: { "#id": "id" },
              ExpressionAttributeValues: { ":id": { S: contactId } },
            },
          },
          { Delete: { TableName, Key: idKey(aliasId, contactId) } },
        ],
      }).pipe(Effect.mapError(missingOn("TransactWriteItems", contactId)), Effect.provide(client));
    }),
  });
});

export const layer = Layer.effect(ContactRepo, make());
