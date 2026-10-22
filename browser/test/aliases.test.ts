import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Page } from "playwright";
import { api, goTo, layer, openPage, signUp, ui } from "./support/browser.ts";

const Aliases = Schema.Array(Schema.Struct({ address: Schema.String, isActive: Schema.Boolean }));

/** The alias's row in the "Aliases" table; a row is named by its cells. */
const row = (page: Page, address: string) =>
  page.getByRole("table", { name: "Aliases" }).getByRole("row", { name: address });

/** Opens "New alias"; with no aliases yet the empty state offers the same button again. */
const newAlias = (page: Page) => page.getByRole("button", { name: "New alias" }).first().click();

/** Picks an entry from the row's "Alias actions" menu. */
const aliasAction = async (page: Page, address: string, action: string) => {
  await row(page, address).getByRole("button", { name: "Alias actions" }).click();
  await page.getByRole("menuitem", { name: action }).click();
};

describe("aliases in the web app", () => {
  it.layer(layer, { timeout: 60_000 })((it) => {
    it.effect("creates a random alias, deactivates and activates it, and deletes it", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        yield* signUp(page, "ada");

        yield* ui(async () => {
          await goTo(page, "Aliases");
          await newAlias(page);
          // A random address on the shared domain, which the dialog picks first.
          await page
            .getByRole("dialog", { name: "New alias" })
            .getByRole("button", { name: "Create alias" })
            .click();
          await page.getByRole("dialog", { name: "New alias" }).waitFor({ state: "detached" });
        });
        const [created, ...others] = yield* api(page, "/v1/aliases", Aliases);
        expect(others).toEqual([]);
        const address = created?.address ?? "";
        expect(created).toEqual({
          address: expect.stringMatching(/^[a-z0-9]+@alias\.test$/),
          isActive: true,
        });
        const active = (checked: boolean) =>
          row(page, address).getByRole("switch", { name: "Active", checked, disabled: false });

        yield* ui(async () => {
          await active(true).waitFor();
          await aliasAction(page, address, "Deactivate");
          await active(false).waitFor();
        });
        expect(yield* api(page, "/v1/aliases", Aliases)).toEqual([{ address, isActive: false }]);

        // Stored, not just drawn: still inactive after a reload; the switch turns it back on.
        yield* ui(async () => {
          await page.reload();
          await active(false).click();
          await active(true).waitFor();
        });
        expect(yield* api(page, "/v1/aliases", Aliases)).toEqual([{ address, isActive: true }]);

        // Deleting asks first, offering to deactivate instead.
        yield* ui(async () => {
          await aliasAction(page, address, "Delete");
          await page
            .getByRole("dialog", { name: "Delete alias?" })
            .getByRole("button", { name: "Delete", exact: true })
            .click();
          await row(page, address).waitFor({ state: "detached" });
        });
        expect(yield* api(page, "/v1/aliases", Aliases)).toEqual([]);
      }),
    );

    it.effect("creates an alias of my choosing on my own subdomain", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        yield* signUp(page, "bob");
        yield* ui(async () => {
          await goTo(page, "Aliases");
          await newAlias(page);
          const dialog = page.getByRole("dialog", { name: "New alias" });
          await dialog.getByRole("combobox", { name: "Domain" }).click();
          await page.getByRole("option", { name: "bob.alias.test" }).click();
          await dialog.getByRole("textbox", { name: "Address" }).fill("shop");
          await dialog.getByRole("button", { name: "Create alias" }).click();
          await row(page, "shop@bob.alias.test").waitFor();
        });
        expect(yield* api(page, "/v1/aliases", Aliases)).toEqual([
          { address: "shop@bob.alias.test", isActive: true },
        ]);
      }),
    );

    it.effect("turns on-the-fly aliases on and off, and keeps the setting", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        yield* signUp(page, "cleo");
        const Settings = Schema.Struct({ isOnTheFlyEnabled: Schema.Boolean });
        /** The opt-in, once the stored setting has loaded (it is disabled until then). */
        const toggle = (checked: boolean) =>
          page.getByRole("switch", { name: "Create aliases on the fly", checked, disabled: false });

        yield* ui(async () => {
          await goTo(page, "Aliases");
          await toggle(false).click();
          await toggle(true).waitFor();
          await page.reload();
          await toggle(true).waitFor();
        });
        expect(yield* api(page, "/v1/settings", Settings)).toEqual({ isOnTheFlyEnabled: true });

        yield* ui(async () => {
          await toggle(true).click();
          await toggle(false).waitFor();
        });
        expect(yield* api(page, "/v1/settings", Settings)).toEqual({ isOnTheFlyEnabled: false });
      }),
    );
  });
});
