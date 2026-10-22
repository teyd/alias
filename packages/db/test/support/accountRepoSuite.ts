import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
// An independent SHA-256 to check the journal key against.
// oxlint-disable-next-line effect/avoid-node-imports
import { createHash } from "node:crypto";
import { Username } from "@alias/core";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import { NodeCrypto } from "@effect/platform-node";
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
  DomainRepo,
  Dynamo,
  OAuthRepo,
  OutboxRepo,
  MessageRepo,
  RecipientRepo,
  SessionRepo,
  TokenRepo,
  UserRepo,
  WebhookRepo,
} from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

const repos = Layer.mergeAll(
  AccountRepo.layer.pipe(Layer.provide(NodeCrypto.layer)),
  AliasRepo.layer,
  ContactRepo.layer,
  DomainRepo.layer,
  OAuthRepo.layer,
  OutboxRepo.layer,
  MessageRepo.layer,
  RecipientRepo.layer,
  SessionRepo.layer,
  TokenRepo.layer,
  UserRepo.layer,
  WebhookRepo.layer,
);

type Repos =
  | AccountRepo.AccountRepo
  | AliasRepo.AliasRepo
  | ContactRepo.ContactRepo
  | DomainRepo.DomainRepo
  | OAuthRepo.OAuthRepo
  | OutboxRepo.OutboxRepo
  | MessageRepo.MessageRepo
  | RecipientRepo.RecipientRepo
  | SessionRepo.SessionRepo
  | TokenRepo.TokenRepo
  | UserRepo.UserRepo
  | WebhookRepo.WebhookRepo
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
 * One user with one of everything the service stores about a user: sessions, tokens, a connected
 * app (its grant, a used and a current refresh token, two access tokens, the redeemed code and
 * one waiting), a drafted email and a day's send count, settings, a recipient, a creation quota, a custom domain, live and deleted aliases
 * on a shared domain, on their subdomain and on their custom domain, contacts, counters, a
 * deletion that stopped halfway, and a temporary inbox with a stored message and its quotas.
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
  const oauth = yield* OAuthRepo.OAuthRepo;
  const issued = (n: number): OAuthRepo.Issued => ({
    access: {
      hash: `${name}access${n}`.padEnd(64, "0"),
      grantId: `grt_${name}`,
      clientId: "mcp_client",
      userId,
      username,
      scopes: ["aliases:read"],
      resource: "https://alias.test/mcp",
      expiresAt: at(9_000_000_000_000),
    },
    refresh: {
      hash: `${name}refresh${n}`.padEnd(64, "0"),
      grantId: `grt_${name}`,
      clientId: "mcp_client",
      userId,
      expiresAt: at(9_000_000_000_000),
    },
  });
  const code = (purpose: string): OAuthRepo.NewCode => ({
    hash: `${name}code${purpose}`.padEnd(64, "0"),
    clientId: "mcp_client",
    clientName: "Claude",
    redirectUri: "http://127.0.0.1/callback",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    scopes: ["aliases:read"],
    resource: "https://alias.test/mcp",
    userId,
    username,
    expiresAt: at(9_000_000_000_000),
  });
  yield* oauth.createCode(code("redeemed"));
  yield* oauth.createCode(code("waiting"));
  yield* oauth.redeemCode(
    { ...code("redeemed"), grantId: Option.none() },
    {
      id: `grt_${name}`,
      userId,
      username,
      clientId: "mcp_client",
      clientName: "Claude",
      scopes: ["aliases:read"],
      resource: "https://alias.test/mcp",
      createdAt: at(1_000),
      expiresAt: at(9_000_000_000_000),
    },
    issued(0),
  );
  yield* oauth.rotate(
    { ...issued(0).refresh, usedAt: Option.none() },
    issued(1),
    at(9_000_000_000_000),
  );
  yield* OutboxRepo.OutboxRepo.use((outbox) =>
    Effect.andThen(
      outbox.create({
        id: `drf_${name}`,
        userId,
        aliasId: `al_${name}`,
        aliasDomain: "alias.test",
        aliasLocal: `${name}-shared`,
        contactId: "c0ntact00000001x",
        to: "grace@store.example",
        contactName: Option.none(),
        subject: "Hello",
        text: "Hi",
        clientName: "Claude",
        createdAt: at(1_000),
        pendingUntil: at(9_000_000_000_000),
        expiresAt: at(9_000_000_000_000),
      }),
      outbox.reserveSend(userId, at(1_000), 50),
    ),
  );
  yield* WebhookRepo.WebhookRepo.use((webhooks) =>
    webhooks.create({
      id: `wh_${name}`,
      userId,
      url: `https://hooks.${name}.example/`,
      eventTypes: ["mail.forwarded"],
      secret: "whsec_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0",
      createdAt: at(1_000),
    }),
  );
  yield* users.updateSettings(userId, {
    isOnTheFlyEnabled: true,
    imageProtection: "off",
    isLinkCleaningEnabled: true,
  });
  yield* recipients.add(
    { id: `rcp_${name}`, userId, address: `${name}@mailbox.example`, createdAt: at(1_000) },
    { tokenHash: "hash", expiresAt: at(9_000_000_000_000), sentAt: at(1_000) },
    3,
  );
  // An OpenPGP key on the recipient item (PLAN.md §20.21).
  yield* Effect.flatMap(Effect.fromOption(yield* recipients.find(userId, `rcp_${name}`)), (found) =>
    recipients.setEncryption(found, {
      publicKey: `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${name}\n-----END PGP PUBLIC KEY BLOCK-----\n`,
      fingerprint: "6E2F1B0C5A0D4E9B8C7A6F5E4D3C2B1A09F8E7D6",
      userIds: [`${name} <${name}@mailbox.example>`],
      expiresAt: Option.none(),
      isSubjectHidden: true,
    }),
  );
  yield* aliases.reserveCreation(userId, at(1_000), 20);

  const subdomain = `${name}.alias.test`;
  const custom = `${name}.example`;
  yield* (yield* DomainRepo.DomainRepo).claim(
    { domain: custom, userId, verificationToken: "tok", createdAt: at(1_000) },
    3,
  );
  const addresses = {
    custom: { domain: custom, localPart: "shop" },
    oldCustom: { domain: custom, localPart: "old" },
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
  yield* aliases.delete({ userId, ...addresses.oldCustom });
  yield* AliasRepo.retire(table, { userId, ...addresses.halfway });

  const temporary = { domain: "tmp.test", localPart: `${name}-temp` };
  yield* aliases.insert({
    id: `al_${name}_temp`,
    userId,
    mode: "inbox",
    createdAt: 1,
    inboxExpiresAt: 9_000_000_000_000,
    retentionDays: 1,
    ...temporary,
  });
  yield* aliases.reserveTemporary(userId, at(1_000), 20);
  const messages = yield* MessageRepo.MessageRepo;
  yield* messages.reserveStorage(userId, at(1_000), 500);
  yield* messages.insert(
    {
      id: `msg_${name}`,
      aliasId: `al_${name}_temp`,
      userId,
      receivedAt: at(1_000),
      expiresAt: at(9_000_000_000_000),
      size: 10,
      objectKey: `inbox/1d/al_${name}_temp/msg_${name}`,
      keyVersion: 1,
      wrappedKey: new Uint8Array([1]),
      summary: new Uint8Array([2]),
    },
    temporary,
  );

  return {
    userId,
    username: name,
    subdomains: [subdomain, `${name}.alias2.test`],
    customDomains: [custom],
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
            // key and `deletedAt`. Aliases on her own subdomain leave none (the username's
            // tombstone covers the subdomain), and neither do her custom domain and its aliases.
            // (The journal's hex hash could spell "ada"; it is checked on its own below.)
            const adas = (item: { readonly pk: string }) =>
              Str.includes("ada")(JSON.stringify(item)) && !item.pk.startsWith("ERASURE#");
            expect(Arr.filter(after, adas)).toEqual([
              { pk: "ALIAS#alias.test#ada-halfway", sk: "ALIAS", attributes: tombstone },
              { pk: "ALIAS#alias.test#ada-old", sk: "ALIAS", attributes: tombstone },
              { pk: "ALIAS#alias.test#ada-shared", sk: "ALIAS", attributes: tombstone },
              { pk: "ALIAS#tmp.test#ada-temp", sk: "ALIAS", attributes: tombstone },
              { pk: `USERNAME#${Username.skeleton("ada")}`, sk: "USERNAME", attributes: tombstone },
            ]);
            const notAdas = (item: { readonly pk: string }) =>
              !Str.includes("ada")(JSON.stringify(item)) && !item.pk.startsWith("ERASURE#");
            expect(Arr.filter(after, notAdas)).toEqual(graces);
            // And one journal entry, naming Ada only by a hash of her random user ID, until its
            // TTL runs out one day after the 7-day recovery window.
            const journal = `ERASURE#${createHash("sha256").update("usr_ada").digest("hex")}`;
            expect(Arr.filter(after, (item) => item.pk.startsWith("ERASURE#"))).toEqual([
              { pk: journal, sk: "ERASURE", attributes: ["expiresAt", "pk", "sk"] },
            ]);
            expect(after).toHaveLength(graces.length + 6);
            // Her OpenPGP key went with her recipient item; Grace's is still there.
            const keys = Arr.filter(before, (item) => item.attributes.includes("encryption"));
            expect(Arr.map(keys, (item) => item.sk)).toEqual([
              "RECIPIENT#ada@mailbox.example",
              "RECIPIENT#grace@mailbox.example",
            ]);
            expect(
              Arr.filter(after, (item) => item.attributes.includes("encryption")).map(
                (item) => item.sk,
              ),
            ).toEqual(["RECIPIENT#grace@mailbox.example"]);

            // The username is never given out again, and nobody owns it.
            const username = yield* Username.parse("ada");
            expect(yield* users.isUsernameTaken(username)).toBe(true);
            expect(yield* users.findByUsername("ada")).toEqual(Option.none());
            expect(yield* users.findById("usr_ada")).toEqual(Option.none());
            // Settings (on the fly, tracker protection) are gone too: only defaults are left.
            expect(yield* users.settings("usr_ada")).toEqual({
              isOnTheFlyEnabled: false,
              imageProtection: "block-trackers",
              isLinkCleaningEnabled: false,
            });
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
            // A temporary inbox's address is never handed out again either.
            expect(
              yield* Effect.flip(
                aliases.insert({
                  id: "al_new",
                  userId: "usr_grace",
                  domain: "tmp.test",
                  localPart: "ada-temp",
                  mode: "inbox",
                  createdAt: 2,
                }),
              ),
            ).toBeInstanceOf(AliasRepo.AliasTaken);
            expect(yield* aliases.listByUser("usr_ada")).toEqual([]);
            // Her custom domain is free again, with every address on it.
            const domains = yield* DomainRepo.DomainRepo;
            expect(yield* domains.find("ada.example")).toEqual(Option.none());
            yield* domains.claim(
              {
                domain: "ada.example",
                userId: "usr_grace",
                verificationToken: "t",
                createdAt: at(2),
              },
              3,
            );
            yield* Effect.forEach(
              ["shop", "old"],
              (localPart) =>
                aliases.insert({
                  id: `al_${localPart}`,
                  userId: "usr_grace",
                  domain: "ada.example",
                  localPart,
                  mode: "forward",
                  createdAt: 2,
                }),
              { concurrency: 1, discard: true },
            );
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
