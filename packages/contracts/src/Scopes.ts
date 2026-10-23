import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

/**
 * What a personal API token may do. Each resource has a `read` scope (GET) and a `write` scope
 * (everything else); a write scope does not imply the read one. Contacts are their own resource
 * because they hold third parties' addresses.
 *
 * `mail:send` lets an MCP client draft mail from an alias to one of its contacts. It sends nothing
 * by itself: every draft waits for the signed-in owner to send it from the web app (PLAN.md
 * §20.24), and no HTTP endpoint takes it.
 *
 * `rules:read` and `rules:write` cover the blocklist and the rules (PLAN.md §20.32), which name
 * third parties' addresses like contacts do.
 *
 * `inboxes:read` and `inboxes:write` reach stored mail and temporary inboxes alone (PLAN.md
 * §20.22), so an assistant or a CI job can hold a "temp-only" token.
 *
 * `deliveries:read` lists failed deliveries and downloads their kept copies; `deliveries:write`
 * sends one again (only ever to the owner's own forwarding address) or deletes it (PLAN.md §20.33).
 */
export const Scope = Schema.Literals([
  "aliases:read",
  "aliases:write",
  "contacts:read",
  "contacts:write",
  "deliveries:read",
  "deliveries:write",
  "domains:read",
  "domains:write",
  "inboxes:read",
  "inboxes:write",
  "recipients:read",
  "recipients:write",
  "rules:read",
  "rules:write",
  "settings:read",
  "settings:write",
  "usernames:read",
  "usernames:write",
  "mail:send",
]);
export type Scope = typeof Scope.Type;

/**
 * Which tokens may call an endpoint; a signed-in browser always may. An endpoint without this
 * annotation is session-only, so a new endpoint is closed to tokens until it names a scope.
 * `Scope` needs a token holding every one of `scopes`; `AnyToken` takes any live token.
 */
export type TokenAccess =
  | { readonly _tag: "Scope"; readonly scopes: readonly [Scope, ...Array<Scope>] }
  | { readonly _tag: "AnyToken" };

export class TokenAccessAnnotation extends Context.Service<TokenAccessAnnotation, TokenAccess>()(
  "@alias/contracts/TokenAccess",
) {}

/** An endpoint, as far as annotating it goes. */
interface Annotatable<E> {
  annotate(key: typeof TokenAccessAnnotation, value: TokenAccess): E;
}

/**
 * Opens the endpoint to tokens holding `scope`, and every one of `others` too (an endpoint that
 * returns two resources' data needs both).
 */
export const requires =
  (scope: Scope, ...others: Array<Scope>) =>
  <E extends Annotatable<E>>(endpoint: E): E =>
    endpoint.annotate(TokenAccessAnnotation, { _tag: "Scope", scopes: [scope, ...others] });

/** Opens the endpoint to every live token. */
export const anyToken = <E extends Annotatable<E>>(endpoint: E): E =>
  endpoint.annotate(TokenAccessAnnotation, { _tag: "AnyToken" });

/**
 * A valid token that may not call this endpoint: it lacks `scope`, or the endpoint is
 * session-only (no `scope`).
 */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { scope: Schema.optionalKey(Scope) },
  { httpApiStatus: 403 },
) {}

/**
 * Too many attempts lately: failed tokens or device codes from this client, sign-up or login
 * challenges from this client, accounts created from this client, or failed logins to this
 * account. Wait and try again (the windows are an hour, a day for accounts).
 */
export class TooManyAttempts extends Schema.TaggedError<TooManyAttempts>()(
  "TooManyAttempts",
  {},
  { httpApiStatus: 429 },
) {}
