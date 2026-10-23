import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { api, goTo, layer, openPage, signUp, ui } from "./support/browser.ts";

const Usernames = Schema.Struct({
  usernames: Schema.Array(
    Schema.Struct({ username: Schema.String, isOnTheFlyEnabled: Schema.Boolean }),
  ),
});

const Aliases = Schema.Array(Schema.Struct({ address: Schema.String }));

describe("additional usernames in the web app (PLAN.md §20.34)", () => {
  it.layer(layer, { timeout: 60_000 })((it) => {
    it.effect("adds a username, creates an alias on it, filters by it, and deletes it", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        yield* signUp(page, "dora");
        const usernames = page.getByRole("table", { name: "Usernames" });
        const aliases = page.getByRole("table", { name: "Aliases" });

        // Added behind the human check, like a sign-up (the emulated widget passes by itself).
        yield* ui(async () => {
          await goTo(page, "Domains");
          await page.getByRole("button", { name: "Add username" }).click();
          const dialog = page.getByRole("dialog", { name: "Add a username" });
          await dialog.getByRole("textbox", { name: "Username" }).fill("dora-work");
          await dialog.getByRole("button", { name: "Add username" }).click();
          await dialog.waitFor({ state: "detached" });
          await usernames.getByRole("row", { name: "dora-work" }).waitFor();
          await page
            .getByRole("switch", { name: "Create aliases on the fly on dora-work", checked: false })
            .click();
          await page
            .getByRole("switch", { name: "Create aliases on the fly on dora-work", checked: true })
            .waitFor();
        });
        expect((yield* api(page, "/v1/usernames", Usernames)).usernames).toEqual([
          { username: "dora", isOnTheFlyEnabled: false },
          { username: "dora-work", isOnTheFlyEnabled: true },
        ]);

        // Alias creation offers the new subdomain.
        yield* ui(async () => {
          await goTo(page, "Aliases");
          const create = async (domain: string, local: string) => {
            await page.getByRole("button", { name: "New alias" }).first().click();
            const dialog = page.getByRole("dialog", { name: "New alias" });
            await dialog.getByRole("combobox", { name: "Domain" }).click();
            await page.getByRole("option", { name: domain }).click();
            await dialog.getByRole("textbox", { name: "Address" }).fill(local);
            await dialog.getByRole("button", { name: "Create alias" }).click();
            await dialog.waitFor({ state: "detached" });
          };
          await create("dora-work.alias.test", "payroll");
          await create("dora.alias.test", "shop");
          await aliases.getByRole("row", { name: "payroll@dora-work.alias.test" }).waitFor();

          // The username filter shows only that username's aliases.
          await page.getByRole("combobox", { name: "Filter by username" }).click();
          await page.getByRole("option", { name: "dora-work" }).click();
          await aliases.getByRole("row", { name: "shop@dora.alias.test" }).waitFor({
            state: "detached",
          });
          await aliases.getByRole("row", { name: "payroll@dora-work.alias.test" }).waitFor();
        });
        expect(new URL(page.url()).searchParams.get("username")).toBe("dora-work");

        // Deleting it asks first, and takes its aliases along.
        yield* ui(async () => {
          await goTo(page, "Domains");
          await page.getByRole("button", { name: "Delete dora-work" }).click();
          const dialog = page.getByRole("dialog", { name: "Delete username?" });
          await dialog.getByRole("button", { name: "Delete username" }).click();
          // The open dialog hides the page from the accessibility tree, so wait for it first.
          await dialog.waitFor({ state: "detached" });
          await usernames.getByRole("row", { name: "dora-work" }).waitFor({ state: "detached" });
        });
        expect((yield* api(page, "/v1/usernames", Usernames)).usernames).toEqual([
          { username: "dora", isOnTheFlyEnabled: false },
        ]);
        expect(yield* api(page, "/v1/aliases", Aliases)).toEqual([
          { address: "shop@dora.alias.test" },
        ]);
      }),
    );
  });
});
