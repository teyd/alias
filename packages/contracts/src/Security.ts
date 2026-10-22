import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Authentication } from "./Auth.ts";

/**
 * The account's sign-ins (PLAN.md §20.30, SR-25): the browser sessions it has, which can be ended
 * one by one or all but the current one at once, and the passkeys that sign in. Session-only: no
 * endpoint names a scope, so a token can neither see nor end sessions.
 */

/** A live browser session. `id` is the hash the table keys it by, never the cookie itself. */
const SessionView = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  /** The session this request came with. */
  isCurrent: Schema.Boolean,
});
export type SessionView = typeof SessionView.Type;

/** A passkey that signs in to the account. */
const PasskeyView = Schema.Struct({
  /** The credential ID, base64url. */
  id: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  /** The last sign-in (or confirmation) with it; none before the first. */
  lastUsedAt: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
  /** How the authenticator is reached (`internal`, `hybrid`, `usb`, …), as it reported. */
  transports: Schema.Array(Schema.String),
});
export type PasskeyView = typeof PasskeyView.Type;

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  { sessionId: Schema.String },
  { httpApiStatus: 404 },
) {}

export const SecurityGroup = HttpApiGroup.make("security")
  .add(HttpApiEndpoint.get("sessions", "/sessions", { success: Schema.Array(SessionView) }))
  .add(
    HttpApiEndpoint.delete("endSession", "/sessions/:sessionId", {
      params: { sessionId: Schema.String },
      error: SessionNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.delete("endOtherSessions", "/sessions", {
      success: Schema.Struct({ ended: Schema.Int }),
    }),
  )
  .add(HttpApiEndpoint.get("passkeys", "/passkeys", { success: Schema.Array(PasskeyView) }))
  .middleware(Authentication)
  .prefix("/v1");
