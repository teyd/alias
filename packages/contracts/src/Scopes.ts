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
 * `inboxes:read` and `inboxes:write` reach stored mail and temporary inboxes alone (PLAN.md
 * §20.22), so an assistant or a CI job can hold a "temp-only" token.
 */
export const Scope = Schema.Literals([
  "aliases:read",
  "aliases:write",
  "contacts:read",
  "contacts:write",
  "domains:read",
  "domains:write",
  "inboxes:read",
  "inboxes:write",
  "recipients:read",
  "recipients:write",
  "settings:read",
  "settings:write",
  "mail:send",
]);
export type Scope = typeof Scope.Type;

/**
 * Which tokens may call an endpoint; a signed-in browser always may. An endpoint without this
 * annotation is session-only, so a new endpoint is closed to tokens until it names a scope.
 * `Scope` needs a token holding that scope; `AnyToken` takes any live token.
 */
export type TokenAccess =
  | { readonly _tag: "Scope"; readonly scope: Scope }
  | { readonly _tag: "AnyToken" };

export class TokenAccessAnnotation extends Context.Service<TokenAccessAnnotation, TokenAccess>()(
  "@alias/contracts/TokenAccess",
) {}

/** An endpoint, as far as annotating it goes. */
interface Annotatable<E> {
  annotate(key: typeof TokenAccessAnnotation, value: TokenAccess): E;
}

/** Opens the endpoint to tokens holding `scope`. */
export const requires =
  (scope: Scope) =>
  <E extends Annotatable<E>>(endpoint: E): E =>
    endpoint.annotate(TokenAccessAnnotation, { _tag: "Scope", scope });

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

/** Too many failed token attempts from this client lately; wait and try again. */
export class TooManyAttempts extends Schema.TaggedError<TooManyAttempts>()(
  "TooManyAttempts",
  {},
  { httpApiStatus: 429 },
) {}
