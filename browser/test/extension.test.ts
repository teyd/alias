import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import type { Page } from "playwright";
import { api, attachAuthenticator, goTo, signUp, stack, ui } from "./support/browser.ts";
import { openExtension } from "./support/extension.ts";

const Aliases = Schema.Array(
  Schema.Struct({ address: Schema.String, description: Schema.optionalKey(Schema.String) }),
);
const Grants = Schema.Array(
  Schema.Struct({ clientName: Schema.String, scopes: Schema.Array(Schema.String) }),
);

/** What the sign-up page's email field holds, and what its input listener saw. */
const emailOf = (page: Page) =>
  ui(async () => ({
    value: await page.getByRole("textbox", { name: "Email" }).inputValue(),
    typed: await page.evaluate(() => document.body.dataset["typed"] ?? ""),
  }));

describe("the browser extension (Chromium, new headless mode)", () => {
  it.layer(stack, { timeout: 120_000 })((it) => {
    it.effect("signs in with OAuth, fills an alias for the site, and signs out", () =>
      Effect.gen(function* () {
        const { context, site, popupUrl } = yield* openExtension();

        // Ada has an account and a session in this profile.
        const app = yield* Effect.promise(() => context.newPage());
        yield* attachAuthenticator(context, app);
        yield* signUp(app, "ada");
        // A second username (PLAN.md §20.34), behind the emulated human check.
        yield* ui(async () => {
          await goTo(app, "Domains");
          await app.getByRole("button", { name: "Add username" }).click();
          const dialog = app.getByRole("dialog", { name: "Add a username" });
          await dialog.getByRole("textbox", { name: "Username" }).fill("ada-work");
          await dialog.getByRole("button", { name: "Add username" }).click();
          await dialog.waitFor({ state: "detached" });
        });

        // Sign in from the popup: the authorization page opens in its own window, where Ada,
        // already signed in, allows exactly the alias scopes.
        const popup = yield* Effect.promise(() => context.newPage());
        // The popup runs under the extension's CSP; a violation fails the test.
        const violations: Array<string> = [];
        popup.on("console", (message) => {
          if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
        });
        const consent = yield* ui(async () => {
          await popup.goto(popupUrl);
          const opened = context.waitForEvent("page");
          await popup.getByRole("button", { name: "Sign in" }).click();
          return opened;
        });
        yield* ui(async () => {
          await consent.getByRole("heading", { name: "Connect this app?" }).waitFor();
          await consent.getByText("through the Alias API").waitFor();
          await consent.getByText("“Alias browser extension”").waitFor();
          await consent.getByRole("button", { name: "Allow" }).click();
          await popup.getByText("ada", { exact: true }).waitFor();
        });
        expect(yield* api(app, "/v1/oauth/grants", Grants)).toEqual([
          { clientName: "Alias browser extension", scopes: ["aliases:read", "aliases:write"] },
        ]);

        // The sign-up page, its email field focused, in front; the popup asks for the tab
        // that's active, as when it opens over it.
        const form = yield* Effect.promise(() => context.newPage());
        yield* ui(async () => {
          await form.goto(`${site}/signup`);
          await form.getByRole("textbox", { name: "Email" }).focus();
          await form.bringToFront();
          await popup.reload();
          await popup.getByRole("button", { name: /Alias for example\.co\.uk/ }).click();
          await popup.getByText(/^Created, filled in/).waitFor();
        });
        expect(yield* emailOf(form)).toEqual({
          value: "example@ada.alias.test",
          typed: "example@ada.alias.test",
        });

        // The same site again: the alias Ada already has.
        yield* ui(async () => {
          await popup.getByRole("button", { name: /Alias for example\.co\.uk/ }).click();
          await popup.getByText(/^You already had this one, filled in/).waitFor();
          await popup.getByRole("button", { name: "New random alias" }).click();
          await popup.getByText(/^Created, filled in/).waitFor();
        });
        const random = (yield* emailOf(form)).value;
        expect(random).toMatch(/^[a-z0-9]+@alias\.test$/);

        // On the other username, picked in the popup.
        yield* ui(async () => {
          await popup
            .getByRole("combobox", { name: "Username" })
            .selectOption("ada-work.alias.test");
          await popup
            .getByRole("button", { name: "Alias for example.co.uk: example@ada-work.alias.test" })
            .click();
          await popup.getByRole("button", { name: "Copy example@ada-work.alias.test" }).waitFor();
        });
        expect((yield* emailOf(form)).value).toBe("example@ada-work.alias.test");

        // Each records the site it was made for.
        const created = yield* api(app, "/v1/aliases", Aliases);
        expect(
          Arr.sort(
            Arr.map(created, (alias) => alias.address),
            Order.String,
          ),
        ).toEqual(
          Arr.sort(["example@ada.alias.test", "example@ada-work.alias.test", random], Order.String),
        );
        expect(Arr.map(created, (alias) => alias.description)).toEqual(
          Arr.map(created, () => "example.co.uk (browser extension)"),
        );
        yield* ui(() => popup.getByRole("button", { name: `Copy ${random}` }).waitFor());

        // Signing out revokes the grant.
        yield* ui(async () => {
          await popup.getByRole("button", { name: "Sign out" }).click();
          await popup.getByRole("heading", { name: "Sign in to Alias" }).waitFor();
        });
        expect(yield* api(app, "/v1/oauth/grants", Grants)).toEqual([]);
        expect(violations).toEqual([]);
      }),
    );
  });
});
