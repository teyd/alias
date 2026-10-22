import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { MAX_FAILURES_PER_HOUR } from "../src/Authentication.ts";
import { MAX_REGISTRATIONS_PER_HOUR } from "../src/oauth/Endpoints.ts";
import * as Browser from "./support/Browser.ts";
import * as DocumentHost from "./support/DocumentHost.ts";
import * as TestApi from "./support/TestApi.ts";

/** RFC 7636 Appendix B. */
const pkce = {
  verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
};
const issuer = Browser.origin;
const resource = `${issuer}/mcp`;
const redirectUri = "http://127.0.0.1:5555/callback";

const Registered = Schema.Struct({ client_id: Schema.String });
const Tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  scope: Schema.String,
  expires_in: Schema.Number,
  token_type: Schema.Literal("Bearer"),
});
const Redirect = Schema.Struct({ redirectTo: Schema.String });

type Api = Effect.Success<typeof TestApi.make>;

/** One string field of a JSON body, decoded (and failing the test when it isn't there). */
const field = (name: string) => (body: Schema.Json) =>
  Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown).pipe(
      Schema.decodeTo(Schema.Struct({ [name]: Schema.String })),
    ),
  )(body)[name] ?? "";
const errorOf = field("error");
const reasonOf = field("reason");
const Scopes = Schema.Struct({ scopes: Schema.Array(Schema.String) });
const Grants = Schema.Array(Schema.Struct({ id: Schema.String }));

const register = Effect.fn("register")(function* (
  api: Api,
  body: Readonly<Record<string, Schema.Json>> = {},
) {
  const response = yield* api.browser().post("/v1/oauth/register", {
    redirect_uris: [redirectUri],
    client_name: "Claude Code",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...body,
  });
  expect(response.status).toBe(201);
  return Schema.decodeUnknownSync(Registered)(response.body).client_id;
});

const request = (clientId: string, overrides: Record<string, string> = {}) => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUri,
  code_challenge: pkce.challenge,
  code_challenge_method: "S256",
  scope: "aliases:read contacts:read",
  state: "st4te",
  resource,
  ...overrides,
});

const query = (url: string) => R.fromEntries(Array.from(new URL(url).searchParams));

/** Ada signed in, a registered client, and the code she approved for `scopes`. */
const approved = Effect.fn("approved")(function* (scopes = ["aliases:read"]) {
  const api = yield* TestApi.make;
  const ada = yield* TestApi.signedIn(api.browser, "ada");
  const clientId = yield* register(api);
  const decided = yield* ada.browser.post("/v1/oauth/authorization/decision", {
    request: request(clientId),
    isApproved: true,
    scopes,
  });
  expect(decided.status).toBe(200);
  const { redirectTo } = Schema.decodeUnknownSync(Redirect)(decided.body);
  return { api, ada, clientId, redirectTo, code: query(redirectTo).code ?? "" };
});

const exchange = (api: Api, fields: Record<string, string>) =>
  api.browser().postForm("/v1/oauth/token", fields);

const redeem = (api: Api, clientId: string, code: string, overrides: Record<string, string> = {}) =>
  exchange(api, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: pkce.verifier,
    resource,
    ...overrides,
  });

const refresh = (api: Api, clientId: string, token: string) =>
  exchange(api, { grant_type: "refresh_token", refresh_token: token, client_id: clientId });

describe("OAuth authorization server (API handler on fakecloud)", () => {
  it.effect("publishes RFC 8414 metadata naming PKCE, iss and both registrations", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const response = yield* api.browser().get("/.well-known/oauth-authorization-server");
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/v1/oauth/token`,
        registration_endpoint: `${issuer}/v1/oauth/register`,
        revocation_endpoint: `${issuer}/v1/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: [
          "authorization_code",
          "refresh_token",
          "urn:ietf:params:oauth:grant-type:device_code",
        ],
        device_authorization_endpoint: `${issuer}/v1/oauth/device_authorization`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
        scopes_supported: expect.arrayContaining(["aliases:read", "contacts:write"]),
      });
    }),
  );

  it.effect("runs the code flow with PKCE, then rotates refresh tokens", () =>
    Effect.gen(function* () {
      const { api, ada, clientId, redirectTo, code } = yield* approved([
        "aliases:read",
        "contacts:read",
      ]);
      // RFC 9207: the issuer comes back with the code, and the client's state.
      expect(redirectTo.startsWith(`${redirectUri}?`)).toBe(true);
      expect(query(redirectTo)).toEqual({ code, state: "st4te", iss: issuer });
      expect(code).toMatch(/^alias_oac_[A-Za-z0-9_-]{43}$/);

      const redeemed = yield* redeem(api, clientId, code);
      expect(redeemed.status).toBe(200);
      expect(redeemed.headers["cache-control"]).toBe("no-store");
      const tokens = Schema.decodeUnknownSync(Tokens)(redeemed.body);
      expect(tokens).toMatchObject({ expires_in: 3600, scope: "aliases:read contacts:read" });
      expect(tokens.access_token).toMatch(/^alias_oat_/);
      expect(tokens.refresh_token).toMatch(/^alias_ort_/);

      const rotated = yield* refresh(api, clientId, tokens.refresh_token);
      expect(rotated.status).toBe(200);
      const next = Schema.decodeUnknownSync(Tokens)(rotated.body);
      expect(next.refresh_token).not.toBe(tokens.refresh_token);

      // A narrower access token on request, never a wider one.
      const narrower = yield* exchange(api, {
        grant_type: "refresh_token",
        refresh_token: next.refresh_token,
        client_id: clientId,
        scope: "aliases:read",
      });
      expect(Schema.decodeUnknownSync(Tokens)(narrower.body).scope).toBe("aliases:read");

      const listed = yield* ada.browser.get("/v1/oauth/grants");
      expect(listed.body).toEqual([
        {
          id: expect.stringMatching(/^grt_/),
          clientId,
          clientName: "Claude Code",
          scopes: ["aliases:read", "contacts:read"],
          createdAt: expect.any(String),
        },
      ]);
    }),
  );

  it.effect("revokes the grant when an old refresh token comes back", () =>
    Effect.gen(function* () {
      const { api, ada, clientId, code } = yield* approved();
      const tokens = Schema.decodeUnknownSync(Tokens)((yield* redeem(api, clientId, code)).body);
      const next = Schema.decodeUnknownSync(Tokens)(
        (yield* refresh(api, clientId, tokens.refresh_token)).body,
      );
      expect(yield* refresh(api, clientId, tokens.refresh_token)).toMatchObject({
        status: 400,
        body: { error: "invalid_grant" },
      });
      // The legitimate holder of the newest token is out too: the grant is gone.
      expect((yield* refresh(api, clientId, next.refresh_token)).status).toBe(400);
      expect((yield* ada.browser.get("/v1/oauth/grants")).body).toEqual([]);
    }),
  );

  it.effect("redeems a code once; a second redemption revokes what the first issued", () =>
    Effect.gen(function* () {
      const { api, clientId, code } = yield* approved();
      const tokens = Schema.decodeUnknownSync(Tokens)((yield* redeem(api, clientId, code)).body);
      expect(yield* redeem(api, clientId, code)).toMatchObject({
        status: 400,
        body: { error: "invalid_grant", error_description: "Code already used." },
      });
      expect((yield* refresh(api, clientId, tokens.refresh_token)).status).toBe(400);
    }),
  );

  it.effect("refuses a code with the wrong verifier, client, redirect URI or resource", () =>
    Effect.gen(function* () {
      const { api, clientId, code } = yield* approved();
      const other = yield* register(api);
      const refused = (overrides: Record<string, string>) =>
        Effect.map(redeem(api, clientId, code, overrides), (response) => [
          response.status,
          errorOf(response.body),
        ]);
      expect(yield* refused({ code_verifier: `${pkce.verifier.slice(0, -1)}l` })).toEqual([
        400,
        "invalid_grant",
      ]);
      expect(yield* refused({ code_verifier: pkce.challenge })).toEqual([400, "invalid_grant"]);
      expect(yield* refused({ client_id: other })).toEqual([400, "invalid_grant"]);
      expect(yield* refused({ redirect_uri: "http://127.0.0.1:5556/callback" })).toEqual([
        400,
        "invalid_grant",
      ]);
      expect(yield* refused({ resource: "https://elsewhere.example/mcp" })).toEqual([
        400,
        "invalid_target",
      ]);
      // None of that used the code up.
      expect((yield* redeem(api, clientId, code)).status).toBe(200);
    }),
  );

  it.effect("lets a code lapse after five minutes", () =>
    Effect.gen(function* () {
      const { api, clientId, code } = yield* approved();
      yield* TestClock.adjust("5 minutes");
      expect(yield* redeem(api, clientId, code)).toMatchObject({
        status: 400,
        body: { error: "invalid_grant" },
      });
    }),
  );

  it.effect("answers malformed token requests with the RFC 6749 errors", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      expect(
        yield* exchange(api, { grant_type: "password", client_id: "mcp_x", username: "ada" }),
      ).toMatchObject({ status: 400, body: { error: "unsupported_grant_type" } });
      expect(
        yield* exchange(api, { grant_type: "authorization_code", client_id: "mcp_x" }),
      ).toMatchObject({
        status: 400,
        body: { error: "invalid_request", error_description: "Missing code." },
      });
      expect(
        yield* exchange(api, { grant_type: "refresh_token", client_id: "mcp_x" }),
      ).toMatchObject({ status: 400, body: { error: "invalid_request" } });
      // Without client_id the request doesn't decode at all.
      expect((yield* exchange(api, { grant_type: "refresh_token" })).status).toBe(400);
    }),
  );

  it.effect("limits failed exchanges per client address", () =>
    Effect.gen(function* () {
      const { api, clientId, code } = yield* approved();
      const guess = (n: number) =>
        refresh(api, clientId, `alias_ort_${String(n).padStart(43, "x")}`);
      yield* Effect.forEach(Arr.range(1, MAX_FAILURES_PER_HOUR), guess, { concurrency: 1 });
      expect(yield* redeem(api, clientId, code)).toMatchObject({
        status: 429,
        body: { _tag: "TooManyAttempts" },
      });
      // Another address isn't affected.
      const elsewhere = Browser.make(api.handle, { sourceIp: "203.0.113.9" });
      expect(
        (yield* elsewhere.postForm("/v1/oauth/token", {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: pkce.verifier,
        })).status,
      ).toBe(200);
    }),
  );

  it.effect("shows the consent screen what the client asks for", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const clientId = yield* register(api, { client_uri: "https://claude.ai" });
      const inspected = yield* ada.browser.post("/v1/oauth/authorization", request(clientId));
      expect(inspected).toMatchObject({
        status: 200,
        body: {
          client: {
            id: clientId,
            name: "Claude Code",
            kind: "registered",
            uri: "https://claude.ai",
            redirectHost: "127.0.0.1:5555",
            isLocalRedirect: true,
          },
          scopes: ["aliases:read", "contacts:read"],
          resource,
        },
      });
      // No scope asked for: every scope is offered.
      const all = yield* ada.browser.post(
        "/v1/oauth/authorization",
        R.remove(request(clientId), "scope"),
      );
      expect(Schema.decodeUnknownSync(Scopes)(all.body).scopes).toContain("settings:write");
      // A loopback redirect may name another port.
      expect(
        (yield* ada.browser.post(
          "/v1/oauth/authorization",
          request(clientId, { redirect_uri: "http://127.0.0.1:61000/callback" }),
        )).status,
      ).toBe(200);
    }),
  );

  it.effect("never redirects for an unknown client or redirect URI", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const clientId = yield* register(api);
      const inspect = (body: Record<string, string>) =>
        ada.browser.post("/v1/oauth/authorization", body);
      expect((yield* inspect(request("mcp_unknown"))).body).toEqual({
        _tag: "InvalidAuthorizationRequest",
        reason: "unknown-client",
      });
      expect(
        (yield* inspect(request(clientId, { redirect_uri: "https://evil.example/callback" }))).body,
      ).toEqual({ _tag: "InvalidAuthorizationRequest", reason: "invalid-redirect-uri" });
      expect(
        (yield* ada.browser.post("/v1/oauth/authorization/decision", {
          request: request(clientId, { redirect_uri: "https://evil.example/callback" }),
          isApproved: true,
          scopes: ["aliases:read"],
        })).body,
      ).toEqual({ _tag: "InvalidAuthorizationRequest", reason: "invalid-redirect-uri" });
    }),
  );

  it.effect("sends other refusals back to the client, with state and issuer", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const clientId = yield* register(api);
      const refusal = (overrides: Record<string, string>) =>
        Effect.map(
          ada.browser.post("/v1/oauth/authorization", request(clientId, overrides)),
          (response) => {
            expect(response.status).toBe(400);
            return {
              reason: reasonOf(response.body),
              ...query(field("redirectTo")(response.body)),
            };
          },
        );
      const back = { state: "st4te", iss: issuer };
      expect(yield* refusal({ code_challenge_method: "plain" })).toEqual({
        reason: "pkce-required",
        error: "invalid_request",
        error_description: "pkce-required",
        ...back,
      });
      expect(yield* refusal({ code_challenge: "" })).toMatchObject({ error: "invalid_request" });
      expect(yield* refusal({ response_type: "token" })).toMatchObject({
        error: "unsupported_response_type",
      });
      expect(yield* refusal({ scope: "aliases:read admin" })).toMatchObject({
        error: "invalid_scope",
      });
      expect(yield* refusal({ resource: "https://elsewhere.example/mcp" })).toMatchObject({
        error: "invalid_target",
      });
    }),
  );

  it.effect("grants only what the user picked, and reports a refusal as access_denied", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const clientId = yield* register(api);
      const decide = (isApproved: boolean, scopes: ReadonlyArray<string>) =>
        ada.browser.post("/v1/oauth/authorization/decision", {
          request: request(clientId),
          isApproved,
          scopes,
        });
      const denied = Schema.decodeUnknownSync(Redirect)((yield* decide(false, [])).body);
      expect(query(denied.redirectTo)).toMatchObject({
        error: "access_denied",
        state: "st4te",
        iss: issuer,
      });
      expect((yield* decide(true, [])).body).toEqual({
        _tag: "InvalidAuthorizationRequest",
        reason: "no-scope-granted",
      });
      // A scope the client never asked for isn't granted either.
      const picked = Schema.decodeUnknownSync(Redirect)(
        (yield* decide(true, ["contacts:read", "settings:write"])).body,
      );
      const tokens = Schema.decodeUnknownSync(Tokens)(
        (yield* redeem(api, clientId, query(picked.redirectTo).code ?? "")).body,
      );
      expect(tokens.scope).toBe("contacts:read");
    }),
  );

  it.effect("keeps consent and connected apps to a signed-in browser", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const clientId = yield* register(api);
      expect((yield* api.browser().post("/v1/oauth/authorization", request(clientId))).status).toBe(
        401,
      );
      const created = yield* ada.browser.post("/v1/tokens", {
        name: "cli",
        scopes: ["aliases:read", "aliases:write", "settings:write"],
      });
      const pat = api.withToken(field("token")(created.body));
      expect((yield* pat.post("/v1/oauth/authorization", request(clientId))).status).toBe(403);
      expect(
        (yield* pat.post("/v1/oauth/authorization/decision", {
          request: request(clientId),
          isApproved: true,
          scopes: ["aliases:read"],
        })).status,
      ).toBe(403);
      expect((yield* pat.get("/v1/oauth/grants")).status).toBe(403);
    }),
  );

  it.effect("revokes a connected app for its user only", () =>
    Effect.gen(function* () {
      const { api, ada, clientId, code } = yield* approved();
      const tokens = Schema.decodeUnknownSync(Tokens)((yield* redeem(api, clientId, code)).body);
      const [grant] = Schema.decodeUnknownSync(Grants)(
        (yield* ada.browser.get("/v1/oauth/grants")).body,
      );
      const grace = yield* TestApi.signedIn(api.browser, "grace");
      expect((yield* grace.browser.delete(`/v1/oauth/grants/${grant?.id}`)).status).toBe(404);
      expect((yield* ada.browser.delete(`/v1/oauth/grants/${grant?.id}`)).status).toBe(204);
      expect((yield* refresh(api, clientId, tokens.refresh_token)).status).toBe(400);
      expect((yield* ada.browser.delete(`/v1/oauth/grants/${grant?.id}`)).status).toBe(404);
    }),
  );

  it.effect("revokes tokens through RFC 7009, answering 200 whatever they were", () =>
    Effect.gen(function* () {
      const { api, ada, clientId, code } = yield* approved();
      const tokens = Schema.decodeUnknownSync(Tokens)((yield* redeem(api, clientId, code)).body);
      const revoke = (token: string) =>
        api.browser().postForm("/v1/oauth/revoke", { token, client_id: clientId });
      expect((yield* revoke("alias_ort_unknown")).status).toBe(200);
      expect((yield* revoke(tokens.access_token)).status).toBe(200);
      // The grant survives an access token's revocation, not a refresh token's.
      expect((yield* ada.browser.get("/v1/oauth/grants")).body).toHaveLength(1);
      expect((yield* revoke(tokens.refresh_token)).status).toBe(200);
      expect((yield* ada.browser.get("/v1/oauth/grants")).body).toEqual([]);
      expect((yield* refresh(api, clientId, tokens.refresh_token)).status).toBe(400);
    }),
  );

  it.effect("registers public clients only, with https or loopback redirects", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const response = yield* api.browser().post("/v1/oauth/register", {
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        client_name: "  ",
        token_endpoint_auth_method: "client_secret_basic",
        application_type: "web",
      });
      expect(response).toMatchObject({
        status: 201,
        body: {
          client_id: expect.stringMatching(/^mcp_/),
          client_name: "Unnamed client",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
        },
      });
      expect(response.body).not.toHaveProperty("client_secret");
      const refused = (body: Schema.Json) =>
        Effect.map(api.browser().post("/v1/oauth/register", body), (result) => [
          result.status,
          errorOf(result.body),
        ]);
      expect(yield* refused({ redirect_uris: ["http://claude.ai/callback"] })).toEqual([
        400,
        "invalid_redirect_uri",
      ]);
      expect(yield* refused({ redirect_uris: ["com.example.app:/cb"] })).toEqual([
        400,
        "invalid_redirect_uri",
      ]);
      expect(yield* refused({ redirect_uris: [] })).toEqual([400, "invalid_client_metadata"]);
      expect(
        yield* refused({ redirect_uris: [redirectUri], grant_types: ["client_credentials"] }),
      ).toEqual([400, "invalid_client_metadata"]);
      expect(
        yield* refused({ redirect_uris: [redirectUri], client_uri: "javascript:alert(1)" }),
      ).toEqual([400, "invalid_client_metadata"]);
    }),
  );

  it.effect("limits registrations per client address and hour", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      // Registrations count successes, so the hour's window is the one TestClock is in.
      yield* Effect.forEach(Arr.range(1, MAX_REGISTRATIONS_PER_HOUR), () => register(api), {
        concurrency: 1,
      });
      expect(
        yield* api.browser().post("/v1/oauth/register", { redirect_uris: [redirectUri] }),
      ).toMatchObject({ status: 429, body: { error: "invalid_request" } });
      const elsewhere = Browser.make(api.handle, { sourceIp: "203.0.113.9" });
      expect(
        (yield* elsewhere.post("/v1/oauth/register", { redirect_uris: [redirectUri] })).status,
      ).toBe(201);
      yield* TestClock.adjust("1 hour");
      expect((yield* register(api)).length).toBeGreaterThan(0);
    }),
  );

  it.effect("accepts a client by its metadata document", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const host = yield* DocumentHost.make((url) => ({
        client_id: url,
        client_name: "Doc Client",
        client_uri: "https://doc.example",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }));
      const inspected = yield* ada.browser.post("/v1/oauth/authorization", request(host.url));
      expect(inspected).toMatchObject({
        status: 200,
        body: { client: { id: host.url, name: "Doc Client", kind: "metadata-document" } },
      });
      const decided = Schema.decodeUnknownSync(Redirect)(
        (yield* ada.browser.post("/v1/oauth/authorization/decision", {
          request: request(host.url),
          isApproved: true,
          scopes: ["aliases:read"],
        })).body,
      );
      const redeemed = yield* redeem(api, host.url, query(decided.redirectTo).code ?? "");
      expect(redeemed.status).toBe(200);
      // The token endpoint needs no second fetch: the code names its client.
      expect(host.fetches()).toBe(2);
      expect((yield* ada.browser.get("/v1/oauth/grants")).body).toMatchObject([
        { clientId: host.url, clientName: "Doc Client" },
      ]);
    }),
  );

  it.effect("refuses metadata documents that don't describe themselves", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const reason = (clientId: string) =>
        Effect.map(ada.browser.post("/v1/oauth/authorization", request(clientId)), (response) =>
          reasonOf(response.body),
        );
      const impostor = yield* DocumentHost.make(() => ({
        client_id: "https://claude.ai/client.json",
        redirect_uris: [redirectUri],
      }));
      expect(yield* reason(impostor.url)).toBe("client-metadata-unavailable");
      const confidential = yield* DocumentHost.make((url) => ({
        client_id: url,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "private_key_jwt",
      }));
      expect(yield* reason(confidential.url)).toBe("client-metadata-unavailable");
      const elsewhere = yield* DocumentHost.make((url) => ({
        client_id: url,
        redirect_uris: ["https://doc.example/callback"],
      }));
      expect(yield* reason(elsewhere.url)).toBe("invalid-redirect-uri");
      expect(yield* reason(impostor.url.replace("client.json", "missing.json"))).toBe(
        "client-metadata-unavailable",
      );
      // Not fetchable under the URL policy: link-local and metadata addresses, no path.
      expect(yield* reason("https://169.254.169.254/latest/meta-data")).toBe("unknown-client");
      expect(yield* reason("https://claude.ai/")).toBe("unknown-client");
    }),
  );
});
