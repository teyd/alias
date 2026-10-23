import { TestApi } from "@alias/api/testing";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as R from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { AliasClient, CodeLogin, Forbidden, OAuthError } from "../src/index.ts";

/** A browser extension's redirect URI (`identity.getRedirectURL()` in Chromium). */
const redirectUri = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/";

const Redirect = Schema.Struct({ redirectTo: Schema.String });

/**
 * The API behind the function URL emulator, Ada signed in, a registered client and a started
 * login. `consent` plays the browser: Ada answers the authorization request in her session, as
 * the web app's `/oauth/authorize` page does, and the redirect comes back.
 */
const started = Effect.fn("started")(function* () {
  const api = yield* TestApi.served;
  const ada = yield* TestApi.signedIn(api.browser, "ada");
  const baseUrl = api.url;
  const clientId = yield* CodeLogin.register({
    baseUrl,
    redirectUri,
    clientName: "Alias browser extension",
  });
  const pending = yield* CodeLogin.start({
    baseUrl,
    clientId,
    redirectUri,
    scopes: ["aliases:read", "aliases:write"],
  });
  const consent = Effect.fn("consent")(function* (isApproved: boolean) {
    const request = R.fromEntries(Array.from(new URL(pending.authorizationUrl).searchParams));
    const decided = yield* ada.browser.post("/v1/oauth/authorization/decision", {
      request,
      isApproved,
      scopes: ["aliases:read", "aliases:write"],
    });
    return Schema.decodeUnknownSync(Redirect)(decided.body).redirectTo;
  });
  return { api, baseUrl, clientId, pending, consent };
});

const services = Layer.merge(FetchHttpClient.layer, NodeCrypto.layer);

describe("CodeLogin: authorization code with PKCE (API on the function URL emulator)", () => {
  it.live("logs in, calls the API with the access token, refreshes, and logs out", () =>
    Effect.gen(function* () {
      const { baseUrl, clientId, pending, consent } = yield* started();
      const url = new URL(pending.authorizationUrl);
      expect(url.pathname).toBe("/oauth/authorize");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(pending.resource).toBe(`${pending.issuer}/v1`);

      const tokens = yield* CodeLogin.finish(pending, yield* consent(true));
      expect(Redacted.value(tokens.accessToken)).toMatch(/^alias_oat_/);
      expect(tokens.scopes).toEqual(["aliases:read", "aliases:write"]);
      const client = yield* AliasClient.make({ baseUrl, token: tokens.accessToken });
      const created = yield* client.aliases.create({
        payload: { _tag: "Random", domain: "alias.test", mode: "forward" },
      });
      expect(yield* client.aliases.list()).toEqual([created]);
      expect(yield* Effect.flip(client.recipients.list())).toEqual(
        new Forbidden({ scope: "recipients:read" }),
      );

      const next = yield* CodeLogin.refresh({
        baseUrl,
        clientId,
        refreshToken: tokens.refreshToken,
      });
      const refreshed = yield* AliasClient.make({ baseUrl, token: next.accessToken });
      expect(yield* refreshed.aliases.list()).toEqual([created]);

      yield* CodeLogin.logout({ baseUrl, clientId, refreshToken: next.refreshToken });
      const gone = yield* Effect.flip(
        CodeLogin.refresh({ baseUrl, clientId, refreshToken: next.refreshToken }),
      );
      expect(gone).toBeInstanceOf(OAuthError);
      expect(yield* Effect.flip(refreshed.aliases.list())).toMatchObject({
        _tag: "Unauthenticated",
      });
    }).pipe(Effect.provide(services)),
  );

  it.live("refuses a redirect with another state, another issuer, or a refusal", () =>
    Effect.gen(function* () {
      const { pending, consent } = yield* started();
      const approved = new URL(yield* consent(true));
      const tampered = (name: string, value: string) => {
        const url = new URL(approved);
        url.searchParams.set(name, value);
        return Effect.flip(CodeLogin.finish(pending, url.href));
      };
      expect(yield* tampered("state", "forged")).toEqual(
        new CodeLogin.CodeLoginFailed({ reason: "state differs" }),
      );
      expect(yield* tampered("iss", "https://evil.example")).toEqual(
        new CodeLogin.CodeLoginFailed({ reason: "issuer differs" }),
      );
      const elsewhere = new URL(approved);
      elsewhere.host = "evil.example";
      expect(yield* Effect.flip(CodeLogin.finish(pending, elsewhere.href))).toEqual(
        new CodeLogin.CodeLoginFailed({ reason: "sent back somewhere else" }),
      );
      expect(yield* Effect.flip(CodeLogin.finish(pending, yield* consent(false)))).toEqual(
        new CodeLogin.CodeLoginFailed({ reason: "access_denied" }),
      );
      // None of that spent the code.
      yield* CodeLogin.finish(pending, approved.href);
    }).pipe(Effect.provide(services)),
  );
});
