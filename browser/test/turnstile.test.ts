import { TestKeys, TurnstileServer } from "@alias/turnstile-emulator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { layer, openPage, ui } from "./support/browser.ts";

/**
 * A page rendering one widget explicitly, logging what the API does, as the probe that recorded
 * Cloudflare's own `api.js` with the same keys did (tools/turnstile-emulator/README.md).
 */
const probe = (scriptUrl: string, siteKey: string) => `<!doctype html>
<div id="widget"></div>
<script>
  window.log = [];
  function ready() {
    window.log.push(["onload", Object.keys(turnstile).filter((key) => key !== "_private").sort()]);
    const id = turnstile.render("#widget", {
      sitekey: "${siteKey}",
      action: "signup",
      callback: (token) => window.log.push(["callback", token, turnstile.getResponse(id)]),
      "error-callback": (code) => {
        window.log.push(["error", code]);
        return true;
      },
    });
    window.log.push(["id", /^cf-chl-widget-[a-z0-9]{5}$/.test(id)]);
  }
</script>
<script src="${scriptUrl}&onload=ready" async defer></script>`;

const API = ["execute", "getResponse", "isExpired", "ready", "remove", "render", "reset"];

describe("the Turnstile emulator's widget (contract: as Cloudflare's api.js behaved)", () => {
  it.layer(layer, { timeout: 60_000 })((it) => {
    const cases = [
      {
        siteKey: TestKeys.siteKeys.passes,
        last: ["callback", TestKeys.DUMMY_TOKEN, TestKeys.DUMMY_TOKEN],
        height: 65,
      },
      {
        siteKey: TestKeys.siteKeys.passesInvisible,
        last: ["callback", TestKeys.DUMMY_TOKEN, TestKeys.DUMMY_TOKEN],
        height: 0,
      },
      { siteKey: TestKeys.siteKeys.blocks, last: ["error", "600010"], height: 65 },
      { siteKey: TestKeys.siteKeys.blocksInvisible, last: ["error", "600010"], height: 0 },
    ];
    it.effect.each(cases)("$siteKey", ({ siteKey, last, height }) =>
      Effect.gen(function* () {
        const { url } = yield* TurnstileServer.TurnstileServer;
        // The probe page has inline scripts the app's CSP refuses; it isn't the app.
        const { page } = yield* openPage({ isCspBypassed: true });
        const scriptUrl = `${url}/turnstile/v0/api.js?render=explicit`;
        yield* ui(async () => {
          await page.goto("/");
          await page.setContent(probe(scriptUrl, siteKey));
          await page.waitForFunction("window.log.length >= 3");
        });
        const log = yield* Effect.promise(() => page.evaluate("window.log"));
        expect(log).toEqual([["onload", API], ["id", true], last]);
        const token = page.locator('#widget input[name="cf-turnstile-response"]');
        expect(yield* Effect.promise(() => token.inputValue())).toBe(
          last[0] === "callback" ? TestKeys.DUMMY_TOKEN : "",
        );
        const box = yield* Effect.promise(() => page.locator("#widget > div").boundingBox());
        expect(box?.height).toBe(height);
      }),
    );
  });
});
