// The one module, not the index: the SDK bundles the contracts and nothing else of core.
import * as Username from "@alias/core/Username";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import { Forbidden, TooManyAttempts, anyToken } from "./Scopes.ts";
import * as WebAuthn from "./WebAuthn.ts";

/**
 * Who is calling. Provided by {@link Authentication} to every endpoint that uses it; handlers
 * read it with `yield* CurrentUser`.
 */
export class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly userId: string; readonly username: string }
>()("@alias/contracts/CurrentUser") {}

/** No live credential: no session cookie or bearer token, or one that is unknown, expired, logged out or revoked. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  {},
  { httpApiStatus: 401 },
) {}

/**
 * A change authenticated by the session cookie that didn't come from the web app itself: its
 * `Sec-Fetch-Site` isn't `same-origin`, its `Origin` isn't the app's (or it names neither), or it
 * has a body that isn't `application/json` (PLAN.md §20.30). Bearer-token requests never get it.
 */
export class CrossSiteRequest extends Schema.TaggedError<CrossSiteRequest>()(
  "CrossSiteRequest",
  {},
  { httpApiStatus: 403 },
) {}

/**
 * The session cookie. `__Host-` makes browsers insist on `Secure`, `Path=/` and no `Domain`, so
 * no subdomain (every username is one) can set or read it.
 */
export const sessionCookie = HttpApiSecurity.apiKey({ key: "__Host-alias_session", in: "cookie" });

/** A personal API token (`alias_pat_…`) in `Authorization: Bearer`. */
const bearerToken = HttpApiSecurity.bearer;

/**
 * Session-cookie or API-token authentication. Add it to a group or endpoint with
 * `.middleware(Authentication)` and the handlers get {@link CurrentUser}. The session is tried
 * first. A token passes only on endpoints annotated with a scope it holds (`requires` in
 * `Scopes.ts`), so endpoints without one stay session-only. Failures, before the handler runs:
 * {@link Unauthenticated} (401) without a live credential, {@link Forbidden} (403) for a token
 * the endpoint doesn't accept, {@link CrossSiteRequest} (403) for a cookie-authenticated change
 * from elsewhere, {@link TooManyAttempts} (429) after too many bad tokens.
 */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentUser }
>()("@alias/contracts/Authentication", {
  security: { session: sessionCookie, token: bearerToken },
  error: [Unauthenticated, Forbidden, CrossSiteRequest, TooManyAttempts],
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

/**
 * The Turnstile token was missing, malformed, expired (tokens live 300 seconds) or redeemed
 * before. Solve the widget again and retry (PLAN.md §20.27).
 */
export class HumanCheckFailed extends Schema.TaggedError<HumanCheckFailed>()(
  "HumanCheckFailed",
  {},
  { httpApiStatus: 400 },
) {}

/**
 * Nobody can sign up right now: too many accounts were created in the last hour (`paused`, a
 * circuit breaker), or Turnstile can't be asked (`human-check-unavailable`). Try again later.
 */
export class SignupUnavailable extends Schema.TaggedError<SignupUnavailable>()(
  "SignupUnavailable",
  { reason: Schema.Literals(["paused", "human-check-unavailable"]) },
  { httpApiStatus: 503 },
) {}

/** What the sign-up form needs before it asks for a challenge: the Turnstile widget to render. */
const SignupConfig = Schema.Struct({
  turnstile: Schema.Struct({
    siteKey: Schema.String,
    /** Load it as a `<script>`, then call `turnstile.render` (explicit rendering). */
    scriptUrl: Schema.String,
  }),
});

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
 * session cookie. Sign-up first needs a solved Turnstile widget (`signup` names it): its token goes
 * with `registerOptions`. Limits (PLAN.md §20.27): challenges per client address and hour, accounts
 * per client address and day, accounts per hour for everyone, and failed logins per account and
 * hour; past one, {@link TooManyAttempts} (429) or {@link SignupUnavailable} (503).
 */
export const AuthGroup = HttpApiGroup.make("auth")
  .add(HttpApiEndpoint.get("signup", "/signup", { success: SignupConfig }))
  .add(
    HttpApiEndpoint.post("registerOptions", "/register/options", {
      payload: Schema.Struct({ username: Schema.String, turnstileToken: Schema.String }),
      success: RegistrationChallenge,
      error: [InvalidUsername, UsernameTaken, HumanCheckFailed, TooManyAttempts, SignupUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("register", "/register", {
      payload: Schema.Struct({
        challengeId: Schema.String,
        credential: WebAuthn.RegistrationCredential,
      }),
      success: Me,
      error: [PasskeyRejected, UsernameTaken, TooManyAttempts, SignupUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("loginOptions", "/login/options", {
      success: AuthenticationChallenge,
      error: TooManyAttempts,
    }),
  )
  .add(
    HttpApiEndpoint.post("login", "/login", {
      payload: Schema.Struct({
        challengeId: Schema.String,
        credential: WebAuthn.AuthenticationCredential,
      }),
      success: Me,
      error: [PasskeyRejected, TooManyAttempts],
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
  .add(anyToken(HttpApiEndpoint.get("me", "/me", { success: Me })))
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
