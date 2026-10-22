import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Browser from "./Browser.ts";
import type * as TestApi from "./TestApi.ts";

type Api = Effect.Success<typeof TestApi.make>;

/** RFC 7636 Appendix B. */
const pkce = {
  verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
};
const redirectUri = "http://127.0.0.1:5555/callback";
const resource = `${Browser.origin}/mcp`;

const Registered = Schema.Struct({ client_id: Schema.String });
const Redirect = Schema.Struct({ redirectTo: Schema.String });
const Tokens = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String });

/**
 * An MCP client connected for `user` the way real ones connect: dynamic registration, the user's
 * consent to `scopes` in their signed-in browser, and a code exchanged with PKCE.
 */
export const connect = Effect.fn("Mcp.connect")(function* (
  api: Api,
  user: { readonly browser: Browser.Client },
  scopes: ReadonlyArray<string>,
) {
  const registered = yield* api
    .browser()
    .post("/v1/oauth/register", { redirect_uris: [redirectUri], client_name: "Test client" });
  const clientId = Schema.decodeUnknownSync(Registered)(registered.body).client_id;
  const decided = yield* user.browser.post("/v1/oauth/authorization/decision", {
    request: {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      scope: scopes.join(" "),
      resource,
    },
    isApproved: true,
    scopes: [...scopes],
  });
  const { redirectTo } = Schema.decodeUnknownSync(Redirect)(decided.body);
  const exchanged = yield* api.browser().postForm("/v1/oauth/token", {
    grant_type: "authorization_code",
    code: new URL(redirectTo).searchParams.get("code") ?? "",
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: pkce.verifier,
    resource,
  });
  return Schema.decodeUnknownSync(Tokens)(exchanged.body);
});

/** The request headers a 2026-07-28 client sends for `method` (and tool `name`). */
export const modernHeaders = (method: string, name?: string): Record<string, string> => {
  const headers = {
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
  };
  return name === undefined ? headers : { ...headers, "mcp-name": name };
};

/** A 2026-07-28 request body: the version and client in `_meta`. */
export const modernRequest = (
  id: number,
  method: string,
  params: Readonly<Record<string, Schema.Json>> = {},
  capabilities: Readonly<Record<string, Schema.Json>> = {},
) => ({
  jsonrpc: "2.0",
  id,
  method,
  params: {
    ...params,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": capabilities,
    },
  },
});

/** POSTs `body` to the MCP endpoint with `token` and `headers`. */
export const post = (
  api: Api,
  token: string,
  body: Schema.Json,
  headers: Readonly<Record<string, string>> = {},
) =>
  Browser.make(api.handle, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  }).post("/mcp", body);

/**
 * A modern `tools/call`, headers and all. `extra` adds params (MRTR's `requestState` and
 * `inputResponses`); `capabilities` is what the client declares.
 */
export const callTool = (
  api: Api,
  token: string,
  name: string,
  args: Readonly<Record<string, Schema.Json>> = {},
  extra: Readonly<Record<string, Schema.Json>> = {},
  capabilities: Readonly<Record<string, Schema.Json>> = {},
) =>
  post(
    api,
    token,
    modernRequest(7, "tools/call", { name, arguments: args, ...extra }, capabilities),
    modernHeaders("tools/call", name),
  );
