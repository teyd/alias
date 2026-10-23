import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import {
  Authentication,
  HumanCheckFailed,
  InvalidUsername,
  SignupUnavailable,
  UsernameTaken,
} from "./Auth.ts";
import { RecipientNotFound, RecipientNotVerified } from "./Recipients.ts";
import { TooManyAttempts, requires } from "./Scopes.ts";

/**
 * One of the caller's usernames (PLAN.md §20.34). Each has its own subdomain of every shared
 * domain (`<username>.alias.example`), where the caller picks the aliases' addresses.
 */
const UsernameView = Schema.Struct({
  username: Schema.String,
  /**
   * The username the account signed up with: the login handle. It can't be deleted; its
   * on-the-fly setting is the account's (`/v1/settings`), and its aliases forward to the
   * account's default destination.
   */
  isPrimary: Schema.Boolean,
  /** `<username>.<shared domain>`, for every shared domain. */
  subdomains: Schema.Array(Schema.String),
  /** Mail to a new address on its subdomains creates that alias and is forwarded. */
  isOnTheFlyEnabled: Schema.Boolean,
  /**
   * Where its aliases forward to, a verified destination; none means the account's default
   * destination. Always none for the primary username.
   */
  defaultRecipientId: Schema.OptionFromOptionalKey(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
});
export type UsernameView = typeof UsernameView.Type;

const Usernames = Schema.Struct({
  /** The primary username first, then the additional ones, oldest first. */
  usernames: Schema.Array(UsernameView),
  /** How many additional usernames an account may have. */
  limit: Schema.Int,
});

/** Only what's given changes. `defaultRecipientId: null` goes back to the account's default. */
const UsernameChanges = Schema.Struct({
  isOnTheFlyEnabled: Schema.optionalKey(Schema.Boolean),
  defaultRecipientId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** Unknown, or someone else's: both look the same. */
export class UsernameNotFound extends Schema.TaggedError<UsernameNotFound>()(
  "UsernameNotFound",
  { username: Schema.String },
  { httpApiStatus: 404 },
) {}

/**
 * The primary username is the login handle: it can't be deleted, and it forwards to the account's
 * default destination (change that under `/v1/recipients`).
 */
export class PrimaryUsername extends Schema.TaggedError<PrimaryUsername>()(
  "PrimaryUsername",
  { username: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The account has as many additional usernames as it may; delete one first. */
export class TooManyUsernames extends Schema.TaggedError<TooManyUsernames>()(
  "TooManyUsernames",
  { limit: Schema.Int },
  { httpApiStatus: 409 },
) {}

const usernameParam = { username: Schema.String };

/**
 * The caller's usernames: the primary one and up to `limit` additional ones, each its own
 * subdomain with its own on-the-fly setting and default destination (PLAN.md §20.34).
 *
 * Adding one is held to sign-up's rules (PLAN.md §20.27): the same name checks (reserved names,
 * lookalikes, names ever taken, erased or deleted), a solved Turnstile widget (its token in
 * `turnstileToken`), and it counts as a new account against the client's daily limit and the
 * hourly circuit breaker. So it is session-only: a token can list, change and delete usernames
 * (`usernames:read`, `usernames:write`), not add them. Deleting one deletes every alias on its
 * subdomains, with their contacts and stored mail, and the name is never given out again, not
 * even to the caller.
 */
export const UsernamesGroup = HttpApiGroup.make("usernames")
  .add(
    requires("usernames:read")(HttpApiEndpoint.get("list", "/usernames", { success: Usernames })),
  )
  .add(
    HttpApiEndpoint.post("add", "/usernames", {
      payload: Schema.Struct({ username: Schema.String, turnstileToken: Schema.String }),
      success: UsernameView.pipe(HttpApiSchema.status(201)),
      error: [
        InvalidUsername,
        UsernameTaken,
        TooManyUsernames,
        HumanCheckFailed,
        TooManyAttempts,
        SignupUnavailable,
      ],
    }),
  )
  .add(
    requires("usernames:write")(
      HttpApiEndpoint.patch("update", "/usernames/:username", {
        params: usernameParam,
        payload: UsernameChanges,
        success: UsernameView,
        error: [UsernameNotFound, PrimaryUsername, RecipientNotFound, RecipientNotVerified],
      }),
    ),
  )
  .add(
    requires("usernames:write")(
      HttpApiEndpoint.delete("remove", "/usernames/:username", {
        params: usernameParam,
        error: [UsernameNotFound, PrimaryUsername],
      }),
    ),
  )
  .middleware(Authentication)
  .prefix("/v1");
