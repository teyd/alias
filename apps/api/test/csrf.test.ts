import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Browser from "./support/Browser.ts";
import * as TestApi from "./support/TestApi.ts";

const Aliases = Schema.Array(Schema.Struct({ id: Schema.String }));
const Created = Schema.Struct({ token: Schema.String });

const body = JSON.stringify({ _tag: "Random", domain: "alias.test", mode: "forward" });
const crossSite = { _tag: "CrossSiteRequest" };

/** What a page on `site` sends with `fetch("/v1/aliases", { mode: "no-cors", body: blob })`. */
const noCorsBlob = (site: string) => ({
  body,
  headers: { origin: site, "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" },
});

// SR-14 (PLAN.md §20.25): SameSite=Strict was the only thing between another site and the API.
describe("CSRF protection for cookie-authenticated changes (API handler on fakecloud)", () => {
  it.effect("refuses another site's no-cors blob POST, which HttpApi would read as JSON", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      expect(
        yield* ada.browser.send("POST", "/v1/aliases", noCorsBlob("https://evil.example")),
      ).toMatchObject({ status: 403, body: crossSite });
      // A same-site foothold (a sibling subdomain) is still another origin.
      expect(
        yield* ada.browser.send("POST", "/v1/aliases", {
          body,
          headers: { origin: "https://img.alias.test", "sec-fetch-site": "same-site" },
        }),
      ).toMatchObject({ status: 403, body: crossSite });
      // Sandboxed frames (the inbox's HTML view) send `Origin: null`.
      expect(
        yield* ada.browser.send("POST", "/v1/aliases", {
          body,
          headers: { origin: "null", "content-type": "application/json" },
        }),
      ).toMatchObject({ status: 403, body: crossSite });
      expect(
        Schema.decodeUnknownSync(Aliases)((yield* ada.browser.get("/v1/aliases")).body),
      ).toEqual([]);
    }),
  );

  it.effect("refuses a same-origin body that isn't declared JSON", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const sameOrigin = { origin: Browser.origin, "sec-fetch-site": "same-origin" };
      const status = (headers: Readonly<Record<string, string>>) =>
        Effect.map(ada.browser.send("POST", "/v1/aliases", { body, headers }), (r) => r.status);
      expect(yield* status(sameOrigin)).toBe(403);
      expect(yield* status({ ...sameOrigin, "content-type": "text/plain" })).toBe(403);
      expect(
        yield* status({ ...sameOrigin, "content-type": "application/x-www-form-urlencoded" }),
      ).toBe(403);
      expect(
        yield* status({ ...sameOrigin, "content-type": "Application/JSON; charset=utf-8" }),
      ).toBe(201);
    }),
  );

  it.effect("needs Origin or Sec-Fetch-Site on a change, and lets reads through without", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      expect(
        yield* ada.browser.send("POST", "/v1/aliases", {
          body,
          headers: { "content-type": "application/json" },
        }),
      ).toMatchObject({ status: 403, body: crossSite });
      // A change without a body, from elsewhere, is refused too.
      expect(
        yield* ada.browser.send("DELETE", "/v1/tokens/tok_unknown", {
          body: "",
          headers: { origin: "https://evil.example" },
        }),
      ).toMatchObject({ status: 403, body: crossSite });
      // Either header alone, when it says the app, is enough.
      expect(
        (yield* ada.browser.send("POST", "/v1/aliases", {
          body,
          headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
        })).status,
      ).toBe(201);
      expect(
        (yield* ada.browser.send("POST", "/v1/aliases", {
          body,
          headers: { origin: Browser.origin, "content-type": "application/json" },
        })).status,
      ).toBe(201);
      expect((yield* ada.browser.get("/v1/aliases")).status).toBe(200);
    }),
  );

  it.effect("leaves bearer-token requests alone", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const created = yield* ada.browser.post("/v1/tokens", {
        name: "script",
        scopes: ["aliases:write", "aliases:read"],
      });
      const { token } = Schema.decodeUnknownSync(Created)(created.body);
      const script = Browser.make(api.handle, { sourceIp: "198.51.100.7" });
      const results = yield* Effect.forEach(
        [{}, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
        (headers) =>
          script.send("POST", "/v1/aliases", {
            body,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              ...headers,
            },
          }),
        { concurrency: 1 },
      );
      expect(Arr.map(results, (r) => r.status)).toEqual([201, 201]);
    }),
  );
});
