import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { layer, openPage, signUp, ui } from "./support/browser.ts";

const Registered = Schema.Struct({ client_id: Schema.String });

/** RFC 7636 Appendix B. */
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const authorizeUrl = (clientId: string, scope: string) =>
  `/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:5555/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    state: "st4te",
  })}`;

describe("the OAuth consent screen", () => {
  it.layer(layer, { timeout: 60_000 })((it) => {
    // SR-15 (PLAN.md §20.25): a registered client's name and website are its own claims.
    it.effect("names no unverified app as itself and links nowhere it chose", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        yield* signUp(page, "ada");
        const registered = yield* Effect.promise(() =>
          page.request
            .post("/v1/oauth/register", {
              data: {
                redirect_uris: ["http://127.0.0.1:5555/callback"],
                client_name: "Claude",
                client_uri: "https://claude.ai",
              },
            })
            .then((response) => response.json()),
        );
        const { client_id } = Schema.decodeUnknownSync(Registered)(registered);

        yield* ui(async () => {
          await page.goto(authorizeUrl(client_id, "aliases:read"));
          await page.getByRole("heading", { name: "Connect this app?" }).waitFor();
          await page.getByText("“Claude”").waitFor();
          await page.getByText("Not verified").waitFor();
        });
        expect(yield* Effect.promise(() => page.getByRole("link").count())).toBe(0);
        expect(yield* Effect.promise(() => page.getByText("claude.ai").count())).toBe(0);

        // A refusal that goes back to the client names where it goes.
        yield* ui(async () => {
          await page.goto(authorizeUrl(client_id, "everything"));
          await page.getByRole("heading", { name: "Can't connect this app" }).waitFor();
          await page.getByRole("button", { name: "Return to 127.0.0.1:5555" }).waitFor();
        });
      }),
    );
  });
});
