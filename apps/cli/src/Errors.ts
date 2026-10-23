import {
  AliasNotFound,
  AliasTaken,
  BlocklistEntryNotFound,
  BlocklistFull,
  InvalidBlocklistEntry,
  ContactNotFound,
  DeviceLogin,
  Forbidden,
  InvalidAlias,
  InvalidAliasRecipient,
  InvalidTemporaryInbox,
  TemporaryInboxLimit,
  TooManyAttempts,
  Unauthenticated,
} from "@alias/sdk";
import { AliasCsv } from "@alias/core";
import * as Effect from "effect/Effect";
import { CliError } from "effect/cli";
import { HttpClientError } from "effect/http";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CredentialsUnreadable } from "./Credentials.ts";

/** No token: neither `ALIAS_TOKEN` nor a saved login. */
export class NotLoggedIn extends Schema.TaggedError<NotLoggedIn>()("NotLoggedIn", {}) {}

/** Not `name@domain`. */
export class InvalidAddress extends Schema.TaggedError<InvalidAddress>()("InvalidAddress", {
  input: Schema.String,
}) {}

/** `alias aliases delete` without `--yes`. */
export class NotConfirmed extends Schema.TaggedError<NotConfirmed>()("NotConfirmed", {}) {}

/** `alias temp --wait`: nothing arrived before the timeout. */
export class NoMail extends Schema.TaggedError<NoMail>()("NoMail", { address: Schema.String }) {}

/** `alias temp --wait --otp`: mail arrived, but no code or verification link was found in it. */
export class NoCode extends Schema.TaggedError<NoCode>()("NoCode", {}) {}

/** None of the caller's verified recipients has this address. */
export class NoSuchRecipient extends Schema.TaggedError<NoSuchRecipient>()("NoSuchRecipient", {
  address: Schema.String,
}) {}

/** No contact of the alias has this id or address. */
export class NoSuchContact extends Schema.TaggedError<NoSuchContact>()("NoSuchContact", {}) {}

const loginFailure = (reason: string) => {
  if (reason === "access_denied") return "The login was denied.";
  if (reason === "expired_token") {
    return "The code expired before it was approved. Run `alias login` again.";
  }
  return `The login failed (${reason}).`;
};

/** What went wrong, for the person at the terminal. Anything unexpected gets a generic line. */
const describe = <E>(error: E): string => {
  if (error instanceof NotLoggedIn) {
    return "Not logged in. Run `alias login` first (or set ALIAS_TOKEN).";
  }
  if (error instanceof Unauthenticated) {
    return "Your login expired or was revoked. Run `alias login` again.";
  }
  if (error instanceof Forbidden) {
    return Option.match(Option.fromUndefinedOr(error.scope), {
      onNone: () => "API tokens can't do that; use the web app.",
      onSome: (scope) => `Your token lacks the ${scope} scope. Run \`alias login\` again.`,
    });
  }
  if (error instanceof TooManyAttempts) {
    return "Too many failed attempts from here. Wait an hour and try again.";
  }
  if (error instanceof AliasNotFound) return `No alias ${error.address}.`;
  if (error instanceof AliasTaken) return `${error.address} is taken.`;
  if (error instanceof InvalidAlias) {
    return `Can't create ${error.address}: ${error.reason.replaceAll("-", " ")}.`;
  }
  if (error instanceof ContactNotFound || error instanceof NoSuchContact) {
    return "That alias has no such contact.";
  }
  if (error instanceof NoSuchRecipient) {
    return `${error.address} isn't one of your verified forwarding addresses (\`alias recipients list\`).`;
  }
  if (error instanceof InvalidAliasRecipient) {
    return "That forwarding address isn't verified yet. Confirm it from its mail first.";
  }
  if (error instanceof AliasCsv.CsvError) {
    return {
      empty: "The file is empty.",
      "no-address-column": "The file has no `address` column in its first line.",
      "unterminated-quote": "The file has a quote that never closes.",
    }[error.reason];
  }
  if (error instanceof InvalidBlocklistEntry) {
    return error.reason === "invalid-address"
      ? "That isn't an address like name@domain."
      : "That isn't a domain like shop.example.";
  }
  if (error instanceof BlocklistFull) return `You can block up to ${error.limit} senders.`;
  if (error instanceof BlocklistEntryNotFound) return `${error.entryId} isn't blocked.`;
  if (error instanceof InvalidAddress) return `${error.input} isn't an address like name@domain.`;
  if (error instanceof NotConfirmed) {
    return "Not deleted. Pass --yes to delete the alias and its contacts for good.";
  }
  if (error instanceof NoMail) return `No mail reached ${error.address} in time.`;
  if (error instanceof NoCode) {
    return "Mail arrived, but no code or link was found in it. Run without --otp to see it.";
  }
  if (error instanceof InvalidTemporaryInbox) {
    return error.reason === "temp-mail-disabled"
      ? "This server has no temporary inboxes."
      : "That domain takes no temporary inboxes.";
  }
  if (error instanceof TemporaryInboxLimit) {
    return "You created as many temporary inboxes as you may today.";
  }
  if (error instanceof DeviceLogin.DeviceLoginFailed) return loginFailure(error.reason);
  if (error instanceof CredentialsUnreadable) return `Can't use ${error.path}: ${error.reason}`;
  if (error instanceof HttpClientError.HttpClientError) {
    return "Can't reach the API. Check the URL (`alias login --api-url`) and your connection.";
  }
  return "Something went wrong.";
};

/** Turns any failure into the CLI's user error: its message printed, exit code 1. */
export const forUser = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.mapError(
    effect,
    (error) => new CliError.UserError({ cause: error, userMessage: describe(error) }),
  );
