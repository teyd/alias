import { sentTo, smtp } from "@alias/e2e/stack";
import { Pipeline } from "@alias/inbound";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WebApp, api, goTo, layer, openPage, signUp, ui } from "./support/browser.ts";

const Recipients = Schema.Array(
  Schema.Struct({
    address: Schema.String,
    isVerified: Schema.Boolean,
    isDefault: Schema.Boolean,
  }),
);
const Aliases = Schema.Array(Schema.Struct({ address: Schema.String }));
const Contacts = Schema.Array(Schema.Struct({ address: Schema.String, isBlocked: Schema.Boolean }));

describe("destinations and contacts in the web app", () => {
  it.layer(layer, { timeout: 60_000 })((it) => {
    it.effect(
      "confirms a destination from its mailed link, then blocks and unblocks a sender",
      () =>
        Effect.gen(function* () {
          const { origin } = yield* WebApp;
          const { page } = yield* openPage();
          const mailbox = "dora@mailbox.example";
          yield* signUp(page, "dora");

          // Adding a destination leaves it pending until its link is opened.
          yield* ui(async () => {
            await goTo(page, "Destinations");
            await page.getByRole("button", { name: "Add destination" }).first().click();
            const dialog = page.getByRole("dialog", { name: "Add destination" });
            await dialog.getByRole("textbox", { name: "Mailbox address" }).fill(mailbox);
            await dialog.getByRole("button", { name: "Send confirmation" }).click();
            await page
              .getByRole("dialog", { name: "Check your inbox" })
              .getByRole("button", { name: "Done" })
              .click();
            await page
              .getByRole("table", { name: "Destinations" })
              .getByRole("row", { name: mailbox })
              .getByRole("button", { name: "Resend link" })
              .waitFor();
          });
          expect(yield* api(page, "/v1/recipients", Recipients)).toEqual([
            { address: mailbox, isVerified: false, isDefault: false },
          ]);

          // The confirmation mail SES sent links to this web app.
          const [confirmation, ...more] = yield* sentTo(mailbox);
          expect(more).toEqual([]);
          const link = new RegExp(`${origin}/destinations\\?\\S+`).exec(confirmation?.text ?? "");
          expect(link).not.toBeNull();
          yield* ui(async () => {
            await page.goto(link?.[0] ?? "/");
            const confirm = page.getByRole("button", { name: "Confirm this address" });
            await confirm.click();
            await confirm.waitFor({ state: "detached" });
            await page.getByRole("button", { name: "Resend link" }).waitFor({ state: "detached" });
          });
          expect(new URL(page.url()).search).toBe("");
          expect(yield* api(page, "/v1/recipients", Recipients)).toEqual([
            { address: mailbox, isVerified: true, isDefault: true },
          ]);

          // A random alias, and a shop writing to it.
          yield* ui(async () => {
            await goTo(page, "Aliases");
            await page.getByRole("button", { name: "New alias" }).first().click();
            await page.getByRole("button", { name: "Create alias" }).click();
            await page.getByRole("dialog", { name: "New alias" }).waitFor({ state: "detached" });
          });
          const [alias] = yield* api(page, "/v1/aliases", Aliases);
          const address = alias?.address ?? "";
          const write = smtp({
            from: '"Store" <orders@store.example>',
            to: address,
            subject: "Order confirmed",
            text: "Thanks for your order!",
          }).pipe(Effect.flatMap(Pipeline.handle));
          expect(yield* write).toEqual([{ _tag: "Forwarded" }]);

          // The sender shows up as a contact of the alias.
          const contactsPath = `/v1/aliases/${address.split("@").reverse().join("/")}/contacts`;
          const contact = page
            .getByRole("list", { name: "Contacts" })
            .getByRole("listitem")
            .filter({ hasText: "orders@store.example" });
          yield* ui(async () => {
            await page
              .getByRole("table", { name: "Aliases" })
              .getByRole("row", { name: address })
              .getByRole("button", { name: "Contacts" })
              .click();
            await contact.getByRole("button", { name: "Block" }).click();
            await contact.getByRole("button", { name: "Unblock" }).waitFor();
          });
          expect(yield* api(page, contactsPath, Contacts)).toEqual([
            { address: "orders@store.example", isBlocked: true },
          ]);
          expect(yield* write).toEqual([{ _tag: "Dropped", reason: "blocked-contact" }]);

          // The open contacts panel is in the URL, so it survives a reload.
          yield* ui(async () => {
            await page.reload();
            await contact.getByRole("button", { name: "Unblock" }).click();
            await contact.getByRole("button", { name: "Block" }).waitFor();
          });
          expect(yield* api(page, contactsPath, Contacts)).toEqual([
            { address: "orders@store.example", isBlocked: false },
          ]);
          expect(yield* write).toEqual([{ _tag: "Forwarded" }]);
          // The confirmation mail and the two forwards; the blocked one never left.
          expect(yield* sentTo(mailbox)).toHaveLength(3);
        }),
    );
  });
});
