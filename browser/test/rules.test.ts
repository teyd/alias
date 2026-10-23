import { sentTo, smtp } from "@alias/e2e/stack";
import { Pipeline } from "@alias/inbound";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Page } from "playwright";
import { WebApp, api, goTo, layer, openPage, signUp, ui } from "./support/browser.ts";

const Aliases = Schema.Array(Schema.Struct({ address: Schema.String }));
const Blocked = Schema.Array(Schema.Struct({ id: Schema.String }));
const Rules = Schema.Array(Schema.Struct({ name: Schema.String, isEnabled: Schema.Boolean }));

/** Adds `mailbox` as a destination and confirms it from the mailed link; then a random alias. */
const destinationAndAlias = Effect.fn("destinationAndAlias")(function* (
  page: Page,
  mailbox: string,
) {
  const { origin } = yield* WebApp;
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
  });
  const [confirmation] = yield* sentTo(mailbox);
  const link = new RegExp(`${origin}/destinations\\?\\S+`).exec(confirmation?.text ?? "");
  yield* ui(async () => {
    await page.goto(link?.[0] ?? "/");
    const confirm = page.getByRole("button", { name: "Confirm this address" });
    await confirm.click();
    await confirm.waitFor({ state: "detached" });
    await goTo(page, "Aliases");
    await page.getByRole("button", { name: "New alias" }).first().click();
    await page.getByRole("button", { name: "Create alias" }).click();
    await page.getByRole("dialog", { name: "New alias" }).waitFor({ state: "detached" });
  });
  const [alias] = yield* api(page, "/v1/aliases", Aliases);
  return alias?.address ?? "";
});

describe("blocklist and rules in the web app", () => {
  it.layer(layer, { timeout: 60_000 })((it) => {
    it.effect("blocks a contact everywhere, lists it, and unblocks it from the blocklist", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        yield* signUp(page, "fay");
        const address = yield* destinationAndAlias(page, "fay@mailbox.example");
        const write = smtp({
          from: '"Store" <orders@store.example>',
          to: address,
          subject: "Order confirmed",
          text: "Thanks!",
        }).pipe(Effect.flatMap(Pipeline.handle));
        expect(yield* write).toEqual([{ _tag: "Forwarded" }]);

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
          await contact.getByRole("button", { name: "Block everywhere" }).click();
          await contact.getByRole("button", { name: "Blocked everywhere" }).waitFor();
        });
        expect(yield* api(page, "/v1/blocklist", Blocked)).toEqual([
          { id: "orders@store.example" },
        ]);
        expect(yield* write).toEqual([{ _tag: "Dropped", reason: "blocked-sender" }]);

        // The Blocklist screen lists it, blocks a whole domain, and unblocks.
        const table = page.getByRole("table", { name: "Blocked senders" });
        yield* ui(async () => {
          await page.goto("/aliases");
          await goTo(page, "Blocklist");
          await table.getByRole("row", { name: /orders@store\.example/ }).waitFor();
          await page.getByRole("textbox", { name: "Sender" }).fill("Ads.Example");
          await page.getByRole("checkbox", { name: /subdomains too/ }).check();
          await page.getByRole("button", { name: "Block sender" }).click();
          await table.getByRole("row", { name: /\*\.ads\.example/ }).waitFor();
          await page.getByRole("button", { name: "Unblock orders@store.example" }).click();
          await page
            .getByRole("button", { name: "Unblock orders@store.example" })
            .waitFor({ state: "detached" });
        });
        expect(yield* api(page, "/v1/blocklist", Blocked)).toEqual([{ id: "*.ads.example" }]);
        expect(yield* write).toEqual([{ _tag: "Forwarded" }]);
      }),
    );

    it.effect("writes a rule that tags mail, tries a sample, and turns the rule off", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        const mailbox = "gus@mailbox.example";
        yield* signUp(page, "gus");
        const address = yield* destinationAndAlias(page, mailbox);

        yield* ui(async () => {
          await goTo(page, "Rules");
          await page.getByRole("button", { name: "New rule" }).first().click();
          const dialog = page.getByRole("dialog", { name: "New rule" });
          await dialog.getByRole("textbox", { name: "Name" }).fill("Store");
          // The first condition starts as "Sender domain is …", the first action as a prefix.
          await dialog.getByRole("textbox", { name: "Condition 1 text" }).fill("store.example");
          await dialog.getByRole("textbox", { name: "Action 1 text" }).fill("[store]");
          await dialog.getByRole("button", { name: "Add action" }).click();
          await dialog.getByRole("combobox", { name: "Action 2" }).click();
          await page.getByRole("option", { name: "Notify my webhooks" }).click();
          await dialog.getByRole("button", { name: "Save rule" }).click();
          await dialog.waitFor({ state: "detached" });
          await page
            .getByRole("list", { name: "Rules" })
            .getByRole("listitem", { name: "Store" })
            .waitFor();
        });
        expect(yield* api(page, "/v1/rules", Rules)).toEqual([{ name: "Store", isEnabled: true }]);

        const write = smtp({
          from: "orders@store.example",
          to: address,
          subject: "Order confirmed",
          text: "Thanks!",
        }).pipe(Effect.flatMap(Pipeline.handle));
        expect(yield* write).toEqual([{ _tag: "Forwarded" }]);
        const lastSubject = Effect.map(sentTo(mailbox), (emails) =>
          Option.fromUndefinedOr(/^Subject: (.*?)\r?$/m.exec(emails.at(-1)?.text ?? "")?.[1]),
        );
        expect(yield* lastSubject).toEqual(Option.some("[store] Order confirmed"));

        // The tester runs the saved rules on a made-up message.
        yield* ui(async () => {
          await page.getByRole("textbox", { name: "Sender" }).fill("news@store.example");
          await page.getByRole("textbox", { name: "Subject" }).fill("Deals");
          await page.getByRole("textbox", { name: "Alias", exact: true }).fill(address);
          await page.getByRole("button", { name: "Test" }).click();
          const result = page.getByRole("status", { name: "Test result" });
          await result.getByText("Matches “Store”.").waitFor();
          await result.getByText("Subject: [store] Deals").waitFor();
          await result.getByText("Your webhooks hear of it.").waitFor();
        });

        // Off, the rule leaves mail alone; the switch survives a reload.
        yield* ui(async () => {
          await page.getByRole("switch", { name: "Store enabled" }).click();
          await page.getByText("Off", { exact: true }).waitFor();
          await page.reload();
          await page.getByText("Off", { exact: true }).waitFor();
        });
        expect(yield* api(page, "/v1/rules", Rules)).toEqual([{ name: "Store", isEnabled: false }]);
        expect(yield* write).toEqual([{ _tag: "Forwarded" }]);
        expect(yield* lastSubject).toEqual(Option.some("Order confirmed"));
      }),
    );
  });
});
