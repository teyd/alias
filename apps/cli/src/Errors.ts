import {
  AliasNotFound,
  AliasTaken,
  ContactNotFound,
  DeviceLogin,
  Forbidden,
  InvalidAlias,
  TooManyAttempts,
  Unauthenticated,
} from "@alias/sdk";
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
  if (error instanceof InvalidAddress) return `${error.input} isn't an address like name@domain.`;
  if (error instanceof NotConfirmed) {
    return "Not deleted. Pass --yes to delete the alias and its contacts for good.";
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
