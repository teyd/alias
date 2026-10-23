import { bounceBack, sentTo, smtp } from "@alias/e2e/stack";
import { Pipeline } from "@alias/inbound";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { Page } from "playwright";
import { api, confirmDestination, goTo, layer, openPage, signUp, ui } from "./support/browser.ts";

const Aliases = Schema.Array(Schema.Struct({ address: Schema.String }));
const Contacts = Schema.Array(Schema.Struct({ address: Schema.String }));

/** Creates a random alias on the Aliases screen and returns its address. */
const newAlias = Effect.fn("newAlias")(function* (page: Page) {
  yield* ui(async () => {
    await goTo(page, "Aliases");
    await page.getByRole("button", { name: "New alias" }).first().click();
    await page.getByRole("button", { name: "Create alias" }).click();
    await page.getByRole("dialog", { name: "New alias" }).waitFor({ state: "detached" });
  });
  const [alias] = yield* api(page, "/v1/aliases", Aliases);
  return alias?.address ?? "";
});

const row = (page: Page, address: string) =>
  page.getByRole("table", { name: "Aliases" }).getByRole("row", { name: address });

describe("new mail from an alias, and failed deliveries, in the web app (PLAN.md §20.33)", () => {
  it.layer(layer, { timeout: 60_000 })((it) => {
    it.effect("sends new mail from an alias; the recipient becomes a contact", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        const mailbox = "fay@mailbox.example";
        yield* signUp(page, "fay");
        yield* confirmDestination(page, mailbox);
        const address = yield* newAlias(page);

        yield* ui(async () => {
          await row(page, address).getByRole("button", { name: "Alias actions" }).click();
          await page.getByRole("menuitem", { name: "Send mail" }).click();
          const dialog = page.getByRole("dialog", { name: "Send mail" });
          await dialog.getByRole("textbox", { name: "To" }).fill("grace@elsewhere.example");
          await dialog.getByRole("textbox", { name: "Subject" }).fill("Hello from my alias");
          await dialog.getByRole("textbox", { name: "Message" }).fill("Nice to meet you.");
          await dialog.getByRole("button", { name: "Send" }).click();
          await dialog.waitFor({ state: "detached" });
          await page.getByText("left from the alias").waitFor();
        });
        const [email, ...more] = yield* sentTo("grace@elsewhere.example");
        expect(more).toEqual([]);
        expect(email?.from).toBe(address);
        expect(email?.text).toContain(`From: ${address}\r\n`);
        expect(email?.text).toContain("Subject: Hello from my alias\r\n");
        // Nothing names the owner's mailbox or account.
        expect(email?.text).not.toContain(mailbox);
        expect(email?.text).not.toContain("fay");

        // Grace is a contact now, and "Write" opens the dialog for her again.
        yield* ui(async () => {
          await row(page, address).getByRole("button", { name: "Contacts" }).click();
          const contact = page
            .getByRole("list", { name: "Contacts" })
            .getByRole("listitem")
            .filter({ hasText: "grace@elsewhere.example" });
          await contact.getByRole("button", { name: "Write" }).click();
          await page
            .getByRole("dialog", { name: "Send mail" })
            .getByRole("textbox", { name: "To" })
            .and(page.locator('[value="grace@elsewhere.example"]'))
            .waitFor();
        });
        const contactsPath = `/v1/aliases/${address.split("@").reverse().join("/")}/contacts`;
        expect(yield* api(page, contactsPath, Contacts)).toEqual([
          { address: "grace@elsewhere.example" },
        ]);
      }),
    );

    it.effect("adds a contact and shows the send-to address to mail it from the mailbox", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        const mailbox = "gus@mailbox.example";
        yield* signUp(page, "gus");
        yield* confirmDestination(page, mailbox);
        const address = yield* newAlias(page);
        const [local = ""] = address.split("@");

        const shown = yield* ui(async () => {
          await row(page, address).getByRole("button", { name: "Contacts" }).click();
          await page
            .getByRole("textbox", { name: "Contact address" })
            .fill("hal@elsewhere.example");
          await page.getByRole("button", { name: "Add contact" }).click();
          await page.getByRole("button", { name: "Copy send-to address" }).waitFor();
          return page.getByText(new RegExp(`^${local}\\+r\\.`)).textContent();
        });
        const sendTo = shown ?? "";
        expect(sendTo).toMatch(new RegExp(`^${local}\\+r\\.[a-z2-7]+@`));

        // Mailed from the verified destination, it goes out to the contact from the alias.
        const replied = yield* smtp({
          from: mailbox,
          to: sendTo,
          subject: "Hi Hal",
          text: "Written in my own mail app.",
        }).pipe(Effect.flatMap(Pipeline.handle));
        expect(replied).toEqual([{ _tag: "Replied" }]);
        const [email] = yield* sentTo("hal@elsewhere.example");
        expect(email?.from).toBe(address);
        expect(email?.text).not.toContain(mailbox);
      }),
    );

    it.effect("lists a failed forward, then sends its kept copy once the destination resumes", () =>
      Effect.gen(function* () {
        // The pipeline runs on the test's clock, the API on the live one: start them together, so
        // the failure's 7 days are counted from now for both.
        yield* TestClock.setTime(DateTime.toEpochMillis(yield* TestClock.withLive(DateTime.now)));
        const { page } = yield* openPage();
        const mailbox = "ivy@mailbox.example";
        yield* signUp(page, "ivy");
        const { userId } = yield* api(page, "/v1/me", Schema.Struct({ userId: Schema.String }));
        yield* ui(async () => {
          await goTo(page, "Settings");
          const keep = page.getByRole("switch", { name: "Keep failed mail for 7 days" });
          await keep.and(page.locator('[aria-busy="false"]')).waitFor();
          await keep.click();
          await keep.and(page.locator('[aria-checked="true"][aria-busy="false"]')).waitFor();
        });
        yield* confirmDestination(page, mailbox);
        const address = yield* newAlias(page);

        // The first forward bounces for good, which pauses the destination.
        const write = (subject: string) =>
          smtp({
            from: "orders@store.example",
            to: address,
            subject,
            text: "Thanks for your order!",
          }).pipe(Effect.flatMap(Pipeline.handle));
        expect(yield* write("First")).toEqual([{ _tag: "Forwarded" }]);
        const sent = Arr.last(yield* sentTo(mailbox));
        yield* bounceBack({
          messageId: Option.getOrElse(
            Option.map(sent, (email) => email.messageId),
            () => "",
          ),
          userId,
          kind: "forward",
          address: mailbox,
          bounceSubType: "General",
          status: "5.1.1",
          diagnosticCode: "smtp; 550 5.1.1 user unknown",
        });
        expect(yield* write("Second")).toEqual([{ _tag: "Dropped", reason: "recipient-bounced" }]);

        yield* ui(async () => {
          await goTo(page, "Failed deliveries");
          const failed = page
            .getByRole("table", { name: "Failed deliveries" })
            .getByRole("row", { name: address });
          await failed.getByText("Destination paused after bouncing").waitFor();
          await failed.getByText("orders@store.example").waitFor();
          // Paused, sending again is refused and says why.
          await failed.getByRole("button", { name: "Resend" }).click();
          await failed.getByText("Resume it on the Destinations screen first").waitFor();
        });
        // The mailbox works again: the owner removes the destination and adds it once more
        // (resuming would too, but mails at most one link a minute).
        yield* ui(async () => {
          await goTo(page, "Destinations");
          await page.getByRole("button", { name: "Destination actions" }).click();
          await page.getByRole("menuitem", { name: "Remove" }).click();
          await page.getByRole("table", { name: "Destinations" }).waitFor({ state: "detached" });
        });
        yield* confirmDestination(page, mailbox);
        const forwardsBefore = Arr.length(yield* sentTo(mailbox));
        yield* ui(async () => {
          await goTo(page, "Failed deliveries");
          const failed = page
            .getByRole("table", { name: "Failed deliveries" })
            .getByRole("row", { name: address });
          await failed.getByRole("button", { name: "Resend" }).click();
          await page.getByText("Nothing failed").waitFor();
        });
        const delivered = yield* sentTo(mailbox);
        expect(delivered).toHaveLength(forwardsBefore + 1);
        const last = Arr.last(delivered);
        expect(Option.map(last, (email) => email.text.includes("Subject: Second"))).toEqual(
          Option.some(true),
        );
      }),
    );
  });
});
