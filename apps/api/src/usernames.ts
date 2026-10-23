import { SharedDomains, Username } from "@alias/core";
import {
  Api,
  CurrentUser,
  InvalidUsername,
  PrimaryUsername,
  RecipientNotFound,
  RecipientNotVerified,
  TooManyUsernames,
  UsernameNotFound,
  UsernameTaken,
  type UsernameView,
} from "@alias/contracts";
import { AliasRepo, RecipientRepo, SignupLimitRepo, UserRepo, UsernameRepo } from "@alias/db";
import type { Inbox } from "@alias/inbox";
import type { Turnstile } from "@alias/turnstile";
import type { Publisher } from "@alias/webhooks";
import * as Arr from "effect/Array";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";
import * as Option from "effect/Option";
import { checkHuman, reserveSignup } from "./auth.ts";
import { deleteWithMail } from "./inboxes.ts";

/** How many usernames an account may have besides the one it signed up with (PLAN.md §20.34). */
const MAX_ADDITIONAL_USERNAMES = 3;

const subdomainsOf = (shared: ReadonlyArray<string>, username: string) =>
  Arr.map(shared, (domain) => `${username}.${domain}`);

/**
 * The subdomains of every username of the caller, the primary one's first: where they pick their
 * aliases' addresses. A username being deleted is left out.
 */
export const callerSubdomains = Effect.fn("usernames.callerSubdomains")(function* () {
  const user = yield* CurrentUser;
  const shared = yield* SharedDomains.SharedDomains;
  const additional = yield* Effect.orDie(
    (yield* UsernameRepo.UsernameRepo).listByUser(user.userId),
  );
  return Arr.flatMap([user.username, ...Arr.map(additional, (entry) => entry.username)], (name) =>
    subdomainsOf(shared, name),
  );
});

/** True when `username` (exactly, as a subdomain carries it) is one of the caller's, live. */
export const isCallerUsername = Effect.fn("usernames.isCallerUsername")(function* (
  username: string,
) {
  const user = yield* CurrentUser;
  if (username === user.username) return true;
  const owner = yield* Effect.orDie((yield* UsernameRepo.UsernameRepo).findOwner(username));
  return Option.exists(owner, (found) => found.userId === user.userId);
});

/** A stored default recipient that was removed since is the account's default again. */
const view = (
  shared: ReadonlyArray<string>,
  recipientIds: ReadonlyArray<string>,
  entry: UsernameRepo.AdditionalUsername,
): UsernameView => ({
  username: entry.username,
  isPrimary: false,
  subdomains: subdomainsOf(shared, entry.username),
  isOnTheFlyEnabled: entry.isOnTheFlyEnabled,
  defaultRecipientId: Option.filter(entry.defaultRecipientId, (id) =>
    Arr.contains(recipientIds, id),
  ),
  createdAt: entry.createdAt,
});

const recipientIdsOf = Effect.fn("usernames.recipientIdsOf")(function* (userId: string) {
  const recipients = yield* Effect.orDie((yield* RecipientRepo.RecipientRepo).list(userId));
  return Arr.map(recipients, (recipient) => recipient.id);
});

const list = Effect.fn("usernames.list")(function* () {
  const user = yield* CurrentUser;
  const shared = yield* SharedDomains.SharedDomains;
  const users = yield* UserRepo.UserRepo;
  // Authentication only lets a user in while their User item exists.
  const account = yield* Effect.orDie(
    Effect.flatMap(users.findById(user.userId), Effect.fromOption),
  );
  const settings = yield* Effect.orDie(users.settings(user.userId));
  const additional = yield* Effect.orDie(
    (yield* UsernameRepo.UsernameRepo).listByUser(user.userId),
  );
  const recipientIds = yield* recipientIdsOf(user.userId);
  const primary: UsernameView = {
    username: user.username,
    isPrimary: true,
    subdomains: subdomainsOf(shared, user.username),
    isOnTheFlyEnabled: settings.isOnTheFlyEnabled,
    defaultRecipientId: Option.none(),
    createdAt: account.createdAt,
  };
  return {
    usernames: [primary, ...Arr.map(additional, (entry) => view(shared, recipientIds, entry))],
    limit: MAX_ADDITIONAL_USERNAMES,
  };
});

/**
 * Adds a username, under sign-up's rules (PLAN.md §20.27): checked like a new account's, the cap
 * checked before the Turnstile token is redeemed (so a refusal doesn't use it up), and counted
 * against the client's and everyone's sign-up limits once a human solved the widget.
 */
const add = Effect.fn("usernames.add")(function* (payload: {
  readonly username: string;
  readonly turnstileToken: string;
}) {
  const user = yield* CurrentUser;
  const requested = payload.username;
  const username = yield* Username.parse(requested).pipe(
    Effect.mapError((error) => new InvalidUsername({ username: requested, reason: error.reason })),
  );
  if (yield* Effect.orDie((yield* UserRepo.UserRepo).isUsernameTaken(username))) {
    return yield* new UsernameTaken({ username });
  }
  const usernames = yield* UsernameRepo.UsernameRepo;
  const current = yield* Effect.orDie(usernames.listByUser(user.userId));
  if (Arr.length(current) >= MAX_ADDITIONAL_USERNAMES) {
    return yield* new TooManyUsernames({ limit: MAX_ADDITIONAL_USERNAMES });
  }
  yield* checkHuman(payload.turnstileToken);
  yield* reserveSignup();
  const added = yield* usernames
    .add(
      { userId: user.userId, username, createdAt: yield* DateTime.now },
      MAX_ADDITIONAL_USERNAMES,
    )
    .pipe(
      Effect.catchTags({
        UsernameTaken: (error) => Effect.fail(new UsernameTaken({ username: error.username })),
        TooManyUsernames: (error) => Effect.fail(new TooManyUsernames({ limit: error.limit })),
        DatabaseError: Effect.die,
      }),
    );
  return view(yield* SharedDomains.SharedDomains, [], added);
});

/** The caller's additional username; the primary one and anyone else's are refused. */
const ownedAdditional = Effect.fn("usernames.ownedAdditional")(function* (username: string) {
  const user = yield* CurrentUser;
  if (username === user.username) return yield* new PrimaryUsername({ username });
  const found = yield* Effect.orDie((yield* UsernameRepo.UsernameRepo).find(user.userId, username));
  return yield* Option.match(found, {
    onNone: () => Effect.fail(new UsernameNotFound({ username })),
    onSome: Effect.succeed,
  });
});

/** The default recipient must be one of the caller's verified destinations. */
const checkRecipient = Effect.fn("usernames.checkRecipient")(function* (recipientId: string) {
  const user = yield* CurrentUser;
  const found = yield* Effect.orDie(
    (yield* RecipientRepo.RecipientRepo).find(user.userId, recipientId),
  );
  if (Option.isNone(found)) return yield* new RecipientNotFound({ recipientId });
  if (Option.isNone(found.value.verifiedAt))
    return yield* new RecipientNotVerified({ recipientId });
});

/**
 * Changes a username's settings; only what's given changes. The primary's on-the-fly setting is
 * the account's; its default destination is the account's, so it takes none of its own.
 */
const update = Effect.fn("usernames.update")(function* (
  username: string,
  changes: UsernameRepo.UsernameChanges,
) {
  const user = yield* CurrentUser;
  if (username === user.username) {
    if (Option.isSome(changes.defaultRecipientId)) return yield* new PrimaryUsername({ username });
    if (Option.isSome(changes.isOnTheFlyEnabled)) {
      yield* Effect.orDie(
        (yield* UserRepo.UserRepo).updateSettings(user.userId, {
          isOnTheFlyEnabled: changes.isOnTheFlyEnabled.value,
        }),
      );
    }
    return yield* Effect.flatMap(list(), (all) =>
      Effect.fromOption(Arr.findFirst(all.usernames, (entry) => entry.isPrimary)),
    ).pipe(Effect.orDie);
  }
  yield* ownedAdditional(username);
  const recipientId = Option.flatten(changes.defaultRecipientId);
  if (Option.isSome(recipientId)) yield* checkRecipient(recipientId.value);
  const updated = yield* (yield* UsernameRepo.UsernameRepo)
    .update(user.userId, username, changes)
    .pipe(
      Effect.catchTags({
        NoSuchUsername: () => Effect.fail(new UsernameNotFound({ username })),
        DatabaseError: Effect.die,
      }),
    );
  return view(yield* SharedDomains.SharedDomains, yield* recipientIdsOf(user.userId), updated);
});

/**
 * Deletes an additional username for good (PLAN.md §20.34), in resumable steps: its claim becomes
 * a tombstone, so nothing new is created on its subdomains and nobody ever gets the name again;
 * then every alias on them goes like a deleted alias (contacts, counters, stored mail, a webhook
 * event each), and their tombstones with them, since the username's tombstone keeps the whole
 * subdomains from anyone else; last, the username leaves the caller's list. A failure anywhere
 * leaves it listed, and deleting it again finishes the job.
 */
const remove = Effect.fn("usernames.remove")(function* (username: string) {
  const user = yield* CurrentUser;
  yield* ownedAdditional(username);
  const usernames = yield* UsernameRepo.UsernameRepo;
  const missing = () => Effect.fail(new UsernameNotFound({ username }));
  yield* usernames
    .retire(user.userId, username)
    .pipe(Effect.catchTags({ NoSuchUsername: missing, DatabaseError: Effect.die }));
  const subdomains = subdomainsOf(yield* SharedDomains.SharedDomains, username);
  const aliases = yield* AliasRepo.AliasRepo;
  const onSubdomains = Arr.filter(yield* Effect.orDie(aliases.listByUser(user.userId)), (alias) =>
    Arr.contains(subdomains, alias.domain),
  );
  yield* Effect.forEach(
    onSubdomains,
    (alias) =>
      deleteWithMail(alias).pipe(
        Effect.catchTag("NoSuchAlias", () => Effect.void),
        Effect.orDie,
      ),
    { concurrency: 4, discard: true },
  );
  yield* Effect.forEach(
    subdomains,
    (subdomain) => Effect.orDie(aliases.releaseDomain(user.userId, subdomain)),
    { concurrency: 1, discard: true },
  );
  yield* usernames
    .remove(user.userId, username)
    .pipe(Effect.catchTags({ NoSuchUsername: missing, DatabaseError: Effect.die }));
});

/** What the username handlers use. The group captures them once, at startup. */
type UsernameServices =
  | Crypto.Crypto
  | UserRepo.UserRepo
  | UsernameRepo.UsernameRepo
  | RecipientRepo.RecipientRepo
  | AliasRepo.AliasRepo
  | SignupLimitRepo.SignupLimitRepo
  | SharedDomains.SharedDomains
  | Turnstile.Turnstile
  | Inbox.Inbox
  | Publisher.Publisher;

export const UsernamesLive = HttpApiBuilder.group(Api, "usernames", (handlers) =>
  Effect.map(Effect.context<UsernameServices>(), (services) =>
    handlers
      .handle("list", () => Effect.provide(list(), services))
      .handle("add", ({ payload }) => Effect.provide(add(payload), services))
      .handle("update", ({ params, payload }) =>
        Effect.provide(
          update(params.username, {
            isOnTheFlyEnabled: Option.fromUndefinedOr(payload.isOnTheFlyEnabled),
            // `null` in the payload goes back to the account's default.
            defaultRecipientId: Option.map(
              Option.fromUndefinedOr(payload.defaultRecipientId),
              Option.fromNullOr,
            ),
          }),
          services,
        ),
      )
      .handle("remove", ({ params }) => Effect.provide(remove(params.username), services)),
  ),
);
