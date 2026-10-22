import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { Username } from "@alias/core";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as R from "effect/Record";
import * as Str from "effect/String";
import {
  AccountRepo,
  AliasRepo,
  ContactRepo,
  Dynamo,
  RecipientRepo,
  SessionRepo,
  TokenRepo,
  UserRepo,
} from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

const repos = Layer.mergeAll(
  AccountRepo.layer,
  AliasRepo.layer,
  ContactRepo.layer,
  RecipientRepo.layer,
  SessionRepo.layer,
  TokenRepo.layer,
  UserRepo.layer,
);

type Repos =
  | AccountRepo.AccountRepo
  | AliasRepo.AliasRepo
  | ContactRepo.ContactRepo
  | RecipientRepo.RecipientRepo
  | SessionRepo.SessionRepo
  | TokenRepo.TokenRepo
  | UserRepo.UserRepo
  | Dynamo.Database;

/** Every item in the table, keys and all, as `{ pk, sk, attribute names }`, sorted by key. */
const scan = Effect.fn("scan")(function* () {
  const table = yield* Dynamo.DynamoTable;
  const { Items } = yield* DynamoDB.scan({ TableName: table.name, ConsistentRead: true });
  const items = Arr.map(Items ?? [], (item) => ({
    pk: item.pk?.S ?? "",
    sk: item.sk?.S ?? "",
    attributes: Arr.sort(R.keys(item), Str.Order),
  }));
  return Arr.sort(
    items,
    Order.mapInput(
      Str.Order,
      (item: { readonly pk: string; readonly sk: string }) => `${item.pk} ${item.sk}`,
    ),
  );
});

/**
 * One user with one of everything the service stores about a user: sessions, settings, a
 * recipient, a creation quota, live and deleted aliases on a shared domain and on their
 * subdomain, contacts, counters, and a deletion that stopped halfway.
 */
const seedUser = Effect.fn("seedUser")(function* (userId: string, name: string) {
  const users = yield* UserRepo.UserRepo;
  const sessions = yield* SessionRepo.SessionRepo;
  const recipients = yield* RecipientRepo.RecipientRepo;
  const aliases = yield* AliasRepo.AliasRepo;
  const contacts = yield* ContactRepo.ContactRepo;
  const table = yield* Dynamo.DynamoTable;
  const username = yield* Username.parse(name);
  yield* users.register(
    { id: userId, username, createdAt: at(1_000) },
    {
      id: `cred_${name}`,
      userId,
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: ["internal"],
      createdAt: at(1_000),
    },
  );
  yield* Effect.forEach(
    ["now", "phone"],
    (device) =>
      sessions.create({
        id: `${name}_${device}`,
        userId,
        username,
        createdAt: at(1_000),
        expiresAt: at(9_000_000_000_000),
      }),
    { concurrency: 1, discard: true },
  );
  yield* Effect.forEach(
    ["cli", "ci"],
    (purpose) =>
      TokenRepo.TokenRepo.use((tokens) =>
        tokens.create({
          id: `tok_${name}_${purpose}`,
          hash: `${name}${purpose}`.padEnd(64, "0"),
          userId,
          username,
          name: purpose,
          scopes: ["aliases:read"],
          hint: "AbCd",
          createdAt: at(1_000),
          expiresAt: Option.none(),
        }),
      ),
    { concurrency: 1, discard: true },
  );
  yield* users.updateSettings(userId, { isOnTheFlyEnabled: true });
  yield* recipients.add(
    { id: `rcp_${name}`, userId, address: `${name}@mailbox.example`, createdAt: at(1_000) },
    { tokenHash: "hash", expiresAt: at(9_000_000_000_000), sentAt: at(1_000) },
    3,
  );
  yield* aliases.reserveCreation(userId, at(1_000), 20);

  const subdomain = `${name}.alias.test`;
  const addresses = {
    shared: { domain: "alias.test", localPart: `${name}-shared` },
    sub: { domain: subdomain, localPart: "shop" },
    oldShared: { domain: "alias.test", localPart: `${name}-old` },
    oldSub: { domain: subdomain, localPart: "old" },
    halfway: { domain: "alias.test", localPart: `${name}-halfway` },
  };
  yield* Effect.forEach(
    R.toEntries(addresses),
    ([key, address]) =>
      Effect.gen(function* () {
        const aliasId = `al_${name}_${key}`;
        yield* aliases.insert({ id: aliasId, userId, mode: "forward", createdAt: 1, ...address });
        yield* contacts.create(
          {
            id: `c_${name}_${key}`.padEnd(16, "x"),
            aliasId,
            address: `someone@${key}.example`,
            name: Option.some("Someone"),
            createdAt: at(1_000),
          },
          address,
        );
        yield* aliases.reserveForward(address.domain, address.localPart, at(1_000), 100);
      }),
    { concurrency: 1, discard: true },
  );
  yield* aliases.delete({ userId, ...addresses.oldShared });
  yield* aliases.delete({ userId, ...addresses.oldSub });
  yield* AliasRepo.retire(table, { userId, ...addresses.halfway });

  return {
    userId,
    username: name,
    subdomains: [subdomain, `${name}.alias2.test`],
    sessionId: `${name}_now`,
  };
});

const tombstone = ["deletedAt", "pk", "sk"];

/**
 * Behaviour AccountRepo must show on every DynamoDB engine. Runners pass the emulator; each test
 * gets its own table on it.
 */
export const accountRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`AccountRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepos = <A, E>(effect: Effect.Effect<A, E, Repos>) =>
        effect.pipe(Effect.provide(repos.pipe(Layer.provideMerge(freshTable()))));

      it.effect("erases everything about a user except bare tombstones", () =>
        withRepos(
          Effect.gen(function* () {
            const accounts = yield* AccountRepo.AccountRepo;
            const users = yield* UserRepo.UserRepo;
            const ada = yield* seedUser("usr_ada", "ada");
            yield* seedUser("usr_grace", "grace");
            const before = yield* scan();
            const graces = Arr.filter(before, (item) => !Str.includes("ada")(JSON.stringify(item)));

            yield* accounts.erase(ada);

            const after = yield* scan();
            // Grace's items are untouched; of Ada's only tombstones are left, each holding its
            // key and `deletedAt`. Aliases on her own subdomain leave none: the username's
            // tombstone covers the subdomain.
            expect(Arr.filter(after, (item) => Str.includes("ada")(JSON.stringify(item)))).toEqual([
              { pk: "ALIAS#alias.test#ada-halfway", sk: "ALIAS", attributes: tombstone },
              { pk: "ALIAS#alias.test#ada-old", sk: "ALIAS", attributes: tombstone },
              { pk: "ALIAS#alias.test#ada-shared", sk: "ALIAS", attributes: tombstone },
              { pk: `USERNAME#${Username.skeleton("ada")}`, sk: "USERNAME", attributes: tombstone },
            ]);
            expect(Arr.filter(after, (item) => !Str.includes("ada")(JSON.stringify(item)))).toEqual(
              graces,
            );
            expect(after).toHaveLength(graces.length + 4);

            // The username is never given out again, and nobody owns it.
            const username = yield* Username.parse("ada");
            expect(yield* users.isUsernameTaken(username)).toBe(true);
            expect(yield* users.findByUsername("ada")).toEqual(Option.none());
            expect(yield* users.findById("usr_ada")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("keeps erased addresses from everyone, the erased user included", () =>
        withRepos(
          Effect.gen(function* () {
            const accounts = yield* AccountRepo.AccountRepo;
            const aliases = yield* AliasRepo.AliasRepo;
            const ada = yield* seedUser("usr_ada", "ada");
            yield* accounts.erase(ada);

            const claim = (userId: string, localPart: string) =>
              Effect.flip(
                aliases.insert({
                  id: "al_new",
                  userId,
                  domain: "alias.test",
                  localPart,
                  mode: "forward",
                  createdAt: 2,
                }),
              );
            expect(yield* claim("usr_grace", "ada-shared")).toBeInstanceOf(AliasRepo.AliasTaken);
            expect(yield* claim("usr_ada", "ada-shared")).toBeInstanceOf(AliasRepo.AliasTaken);
            expect(yield* claim("usr_ada", "ada-old")).toBeInstanceOf(AliasRepo.AliasTaken);
            expect(yield* aliases.isDeleted("alias.test", "ada-halfway")).toBe(true);
            expect(yield* aliases.listByUser("usr_ada")).toEqual([]);
          }),
        ),
      );

      it.effect("finishes an erasure that stopped halfway, and changes nothing once done", () =>
        withRepos(
          Effect.gen(function* () {
            const accounts = yield* AccountRepo.AccountRepo;
            const sessions = yield* SessionRepo.SessionRepo;
            const ada = yield* seedUser("usr_ada", "ada");
            // An erasure that got as far as Ada's other sessions, then failed.
            yield* sessions.delete("ada_phone");
            expect(Option.isSome(yield* sessions.find("ada_now"))).toBe(true);

            yield* accounts.erase(ada);
            const erased = yield* scan();
            yield* accounts.erase(ada);

            expect(yield* scan()).toEqual(erased);
            expect(yield* sessions.find("ada_now")).toEqual(Option.none());
          }),
        ),
      );
    });
  });
