import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as P from "effect/Predicate";
import { HttpApi, OpenApi } from "effect/http-api";
import { Api } from "./Api.ts";
import { type TokenAccess, TokenAccessAnnotation } from "./Scopes.ts";

/**
 * What each group is for, as OpenAPI tag descriptions. Kept here rather than on the groups, so
 * documenting the API never conflicts with changing it.
 */
const groups = {
  system: "Liveness.",
  auth: "Passkey sign-up and login (browser only). Each ceremony is an options call and a verify call.",
  account: "The signed-in account: who it is, and erasing it (GDPR Art. 17).",
  aliases:
    "Aliases, addressed by their address. Other users' aliases answer `AliasNotFound`, so lookups reveal nothing.",
  contacts:
    "The people who wrote to an alias. Blocking one drops its mail and replies to it; deleting one revokes its reverse alias.",
  recipients:
    "Forwarding addresses (destinations). Adding one mails a confirmation link; mail is forwarded only to verified ones.",
  settings: "Account settings.",
  tokens:
    "Personal API tokens (`alias_pat_…`). Session-only: a token can't mint, list or revoke tokens.",
  webhooks:
    "Webhook endpoints, signed per Standard Webhooks. Session-only: an endpoint is a standing data sink.",
  oauth:
    "The device side of a device login (OAuth 2.0 device authorization grant, RFC 8628) and token revocation (RFC 7009). Form-encoded requests, no credentials.",
  device:
    "The signed-in person's side of a device login: look up the code a device shows, then approve or deny it. Session-only.",
} satisfies Record<string, string>;

const schemes = {
  session: "The web app's session cookie, set by a passkey login.",
  token: "A personal API token (`alias_pat_…`). Each operation names the scope it needs.",
} satisfies Record<string, string>;

/** One line per operation, keyed by operation ID (`<group>.<endpoint>`). */
const summaries = {
  "system.health": "Health check",
  "auth.registerOptions": "Start a passkey sign-up",
  "auth.register": "Finish a passkey sign-up and start a session",
  "auth.loginOptions": "Start a passkey login",
  "auth.login": "Finish a passkey login and start a session",
  "auth.logout": "End the session",
  "account.me": "Who is calling",
  "account.eraseOptions": "Start erasing the account",
  "account.erase": "Erase the account, confirmed with a fresh passkey assertion",
  "aliases.list": "List your aliases",
  "aliases.domains": "Domains you may create aliases on",
  "aliases.create": "Create an alias",
  "aliases.lookup": "Get one alias",
  "aliases.update": "Enable, disable or change an alias",
  "aliases.remove": "Delete an alias for good",
  "contacts.list": "List an alias's contacts",
  "contacts.update": "Block or unblock a contact",
  "contacts.remove": "Delete a contact and revoke its reverse alias",
  "recipients.list": "List your forwarding addresses",
  "recipients.add": "Add a forwarding address and mail it a confirmation link",
  "recipients.confirm": "Confirm a forwarding address with the token from its link",
  "recipients.resend": "Mail the confirmation link again",
  "recipients.makeDefault": "Make a verified address the default",
  "recipients.remove": "Remove a forwarding address",
  "settings.get": "Get your settings",
  "settings.update": "Change your settings",
  "tokens.list": "List your API tokens",
  "tokens.create": "Create an API token (the secret is shown once)",
  "tokens.revoke": "Revoke an API token",
  "webhooks.list": "List your webhook endpoints",
  "webhooks.create": "Register a webhook endpoint (the secret is shown once)",
  "webhooks.update": "Pause, resume or resubscribe a webhook endpoint",
  "webhooks.rotateSecret": "Rotate a webhook signing secret",
  "webhooks.remove": "Delete a webhook endpoint",
  "oauth.deviceAuthorization": "Start a device login: get a device code and a user code",
  "oauth.token": "Poll for the token a device login issues",
  "oauth.revoke": "Revoke a token (RFC 7009)",
  "device.lookup": "Look up a device login by its user code",
  "device.approve": "Approve a device login: the device gets a token with the requested scopes",
  "device.deny": "Deny a device login",
} satisfies Record<string, string>;

/** A text by name; None when there is none. */
const text = (texts: Readonly<Record<string, string>>, key: string) => R.get(texts, key);

/** Which tokens each operation takes, from the `requires`/`anyToken` annotations. */
const tokenAccess = (() => {
  const entries: Array<readonly [string, Option.Option<TokenAccess>]> = [];
  HttpApi.reflect(Api, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint }) => {
      entries.push([
        `${group.identifier}.${endpoint.identifier}`,
        Context.getOption(endpoint.annotations, TokenAccessAnnotation),
      ]);
    },
  });
  return R.fromEntries(entries);
})();

/** The token's roles in a security requirement: the scope it needs, or none for any token. */
const roles = (access: TokenAccess): Array<string> =>
  P.isTagged(access, "Scope") ? [access.scope] : [];

type Operation = OpenApi.OpenAPISpecOperation;

const methods: ReadonlyArray<OpenApi.OpenAPISpecMethodName> = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
];

/**
 * Effect lists every security scheme of the `Authentication` middleware on each operation. This
 * narrows the token alternative to what the operation accepts: the scope it names (as the
 * requirement's role, which OpenAPI 3.1 allows for non-OAuth schemes), any token, or none at all
 * (session-only), and says so in the description. Operations without authentication only get
 * their summary.
 */
const document = (operation: Operation): Operation => {
  const summarized = Option.match(text(summaries, operation.operationId), {
    onNone: () => operation,
    onSome: (summary) => ({ ...operation, summary }),
  });
  if (!Arr.isArrayNonEmpty(operation.security)) return summarized;
  const access = Option.flatten(R.get(tokenAccess, operation.operationId));
  return {
    ...summarized,
    description: Option.match(access, {
      onNone: () => "Session only: API tokens are refused.",
      onSome: (found) =>
        Arr.match(roles(found), {
          onEmpty: () => "Any API token may call it.",
          onNonEmpty: ([scope]) => `API tokens need the \`${scope}\` scope.`,
        }),
    }),
    security: Option.match(access, {
      onNone: () => [{ session: [] }],
      onSome: (found) => [{ session: [] }, { token: roles(found) }],
    }),
  };
};

const documentPath = (item: OpenApi.OpenAPISpecPathItem): OpenApi.OpenAPISpecPathItem =>
  Arr.reduce(methods, item, (documented, method) =>
    Option.match(Option.fromUndefinedOr(documented[method]), {
      onNone: () => documented,
      onSome: (operation) => ({ ...documented, [method]: document(operation) }),
    }),
  );

const base = OpenApi.fromApi(Api);

/**
 * The API's OpenAPI 3.1 document: Effect's, generated from {@link Api}, with summaries, tag
 * descriptions and per-operation token scopes. Served at `/v1/openapi.json`; a copy is checked in
 * as `packages/contracts/openapi.json` (`pnpm openapi`, and `pnpm check` fails on drift).
 */
export const openApiDocument: OpenApi.OpenAPISpec = {
  ...base,
  info: {
    title: "Alias API",
    version: "1",
    description:
      "Open-source email aliases. Authenticate with the browser session cookie or a personal API token (`Authorization: Bearer alias_pat_…`) that holds the scope an operation names.",
    license: { name: "AGPL-3.0-only", url: "https://www.gnu.org/licenses/agpl-3.0.html" },
  },
  tags: Arr.map(base.tags, (tag) =>
    Option.match(text(groups, tag.name), {
      onNone: () => tag,
      onSome: (description) => ({ ...tag, description }),
    }),
  ),
  paths: R.map(base.paths, documentPath),
  components: {
    ...base.components,
    securitySchemes: R.map(base.components.securitySchemes, (scheme, name) =>
      Option.match(text(schemes, name), {
        onNone: () => scheme,
        onSome: (description) => ({ ...scheme, description }),
      }),
    ),
  },
};
