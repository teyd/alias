import { InvalidUsername, type Me, PasskeyRejected, UsernameTaken } from "@alias/contracts";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Client } from "./api";

/** Why a sign-up or login failed, worded for the person at the keyboard. */
export class AuthFailed extends Schema.TaggedError<AuthFailed>()("AuthFailed", {
  message: Schema.String,
}) {}

/** The browser or the person cancelled the passkey prompt, or no authenticator was available. */
class PasskeyPromptFailed extends Schema.TaggedError<PasskeyPromptFailed>()("PasskeyPromptFailed", {
  reason: Schema.String,
}) {}

const prompt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new PasskeyPromptFailed({ reason: String(cause) }),
  });

const usernameProblems = {
  "too-short": "Usernames need at least 3 characters.",
  "too-long": "Usernames can have at most 30 characters.",
  "invalid-characters": "Use only lowercase letters, digits and single hyphens.",
  "must-start-with-letter": "Usernames start with a letter.",
  "hyphen-placement": "Hyphens can't end a username or come in pairs.",
  reserved: "That username is reserved.",
} as const;

const passkeyProblems = {
  "challenge-expired": "The passkey prompt took too long. Please try again.",
  "unknown-credential": "This passkey isn't registered here.",
  "credential-taken": "This passkey is already registered.",
  "verification-failed": "The passkey couldn't be verified.",
} as const;

const describe = <E>(error: E): string => {
  if (error instanceof InvalidUsername) return usernameProblems[error.reason];
  if (error instanceof UsernameTaken) return "That username is taken.";
  if (error instanceof PasskeyRejected) return passkeyProblems[error.reason];
  if (error instanceof PasskeyPromptFailed) {
    return "The passkey prompt was cancelled or isn't available.";
  }
  return "Something went wrong. Please try again.";
};

/** Replaces every failure with an `AuthFailed` carrying a readable message. */
const explain = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.mapError(effect, (error) => new AuthFailed({ message: describe(error) }));

/** Creates an account with a new passkey; the response sets the session cookie. */
export const signUp = (api: Client, username: string): Effect.Effect<Me, AuthFailed> =>
  explain(
    Effect.gen(function* () {
      const { challengeId, options } = yield* api.auth.registerOptions({ payload: { username } });
      const credential = yield* prompt(() => startRegistration({ optionsJSON: options }));
      return yield* api.auth.register({ payload: { challengeId, credential } });
    }),
  );

/** Logs in with any passkey the browser holds for this site. */
export const logIn = (api: Client): Effect.Effect<Me, AuthFailed> =>
  explain(
    Effect.gen(function* () {
      const { challengeId, options } = yield* api.auth.loginOptions();
      const credential = yield* prompt(() => startAuthentication({ optionsJSON: options }));
      return yield* api.auth.login({ payload: { challengeId, credential } });
    }),
  );
