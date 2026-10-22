import { Username } from "@alias/core";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import * as WebAuthn from "./WebAuthn.ts";

/**
 * Who is calling. Provided by {@link Authentication} to every endpoint that uses it; handlers
 * read it with `yield* CurrentUser`.
 */
export class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly userId: string; readonly username: string }
>()("@alias/contracts/CurrentUser") {}

/** No session cookie, or one that is unknown, expired or logged out. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  {},
  { httpApiStatus: 401 },
) {}

/**
 * The session cookie. `__Host-` makes browsers insist on `Secure`, `Path=/` and no `Domain`, so
 * no subdomain (every username is one) can set or read it.
 */
export const sessionCookie = HttpApiSecurity.apiKey({ key: "__Host-alias_session", in: "cookie" });

/**
 * Session-cookie authentication. Add it to a group or endpoint with `.middleware(Authentication)`
 * and the handlers get {@link CurrentUser}; requests without a live session fail with
 * {@link Unauthenticated} (401) before the handler runs.
 */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentUser }
>()("@alias/contracts/Authentication", {
  security: { session: sessionCookie },
  error: Unauthenticated,
}) {}

const Me = Schema.Struct({ userId: Schema.String, username: Schema.String });
export type Me = typeof Me.Type;

export class InvalidUsername extends Schema.TaggedError<InvalidUsername>()(
  "InvalidUsername",
  { username: Schema.String, reason: Username.InvalidUsernameReason },
  { httpApiStatus: 400 },
) {}

/** The username, or a lookalike of it, belongs to someone else. */
export class UsernameTaken extends Schema.TaggedError<UsernameTaken>()(
  "UsernameTaken",
  { username: Schema.String },
  { httpApiStatus: 409 },
) {}

/**
 * The ceremony failed: the challenge was unknown, used or expired, the passkey is not registered,
 * or the signature or attestation did not verify. Clients restart from the options call.
 */
export class PasskeyRejected extends Schema.TaggedError<PasskeyRejected>()(
  "PasskeyRejected",
  {
    reason: Schema.Literals([
      "challenge-expired",
      "unknown-credential",
      "credential-taken",
      "verification-failed",
    ]),
  },
  { httpApiStatus: 400 },
) {}

/** A challenge to answer with `navigator.credentials.create()`; send it back with its ID. */
const RegistrationChallenge = Schema.Struct({
  challengeId: Schema.String,
  options: WebAuthn.CreationOptions,
});

/** A challenge to answer with `navigator.credentials.get()`; send it back with its ID. */
const AuthenticationChallenge = Schema.Struct({
  challengeId: Schema.String,
  options: WebAuthn.RequestOptions,
});

/**
 * Passkey sign-up and login. Each ceremony is two calls: `*Options` issues a single-use challenge
 * (valid for 5 minutes), and the second call verifies the authenticator's answer and sets the
 * session cookie.
 */
export const AuthGroup = HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("registerOptions", "/register/options", {
      payload: Schema.Struct({ username: Schema.String }),
      success: RegistrationChallenge,
      error: [InvalidUsername, UsernameTaken],
    }),
  )
  .add(
    HttpApiEndpoint.post("register", "/register", {
      payload: Schema.Struct({
        challengeId: Schema.String,
        credential: WebAuthn.RegistrationCredential,
      }),
      success: Me,
      error: [PasskeyRejected, UsernameTaken],
    }),
  )
  .add(
    HttpApiEndpoint.post("loginOptions", "/login/options", {
      success: AuthenticationChallenge,
    }),
  )
  .add(
    HttpApiEndpoint.post("login", "/login", {
      payload: Schema.Struct({
        challengeId: Schema.String,
        credential: WebAuthn.AuthenticationCredential,
      }),
      success: Me,
      error: PasskeyRejected,
    }),
  )
  .add(
    // Always succeeds and clears the cookie, whether or not the session was still live.
    HttpApiEndpoint.post("logout", "/logout"),
  )
  .prefix("/v1/auth");

/**
 * The signed-in account. Erasing it (GDPR Art. 17) is two calls, like a login: `eraseOptions`
 * issues a single-use challenge for this account only, and `erase` takes a fresh passkey
 * assertion answering it, erases everything stored about the account except the tombstones that
 * keep its username and shared-domain addresses from ever being reused, and clears the session
 * cookie. If `erase` fails halfway, calling both again finishes the job.
 */
export const AccountGroup = HttpApiGroup.make("account")
  .add(HttpApiEndpoint.get("me", "/me", { success: Me }))
  .add(
    HttpApiEndpoint.post("eraseOptions", "/me/erase/options", {
      success: AuthenticationChallenge,
    }),
  )
  .add(
    HttpApiEndpoint.post("erase", "/me/erase", {
      payload: Schema.Struct({
        challengeId: Schema.String,
        credential: WebAuthn.AuthenticationCredential,
      }),
      error: PasskeyRejected,
    }),
  )
  .middleware(Authentication)
  .prefix("/v1");
