import { smtp } from "@alias/e2e/stack";
import { Pipeline } from "@alias/inbound";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { api, goTo, layer, openPage, signUp, ui } from "./support/browser.ts";

const Inboxes = Schema.Array(
  Schema.Struct({ address: Schema.String, isTemporary: Schema.Boolean }),
);

describe("inbox in the web app", () => {
  it.layer(layer, { timeout: 60_000 })((it) => {
    it.effect("creates a temporary inbox, shows mail to it with the code, and opens it", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        yield* signUp(page, "ada");
        yield* ui(async () => {
          await goTo(page, "Inbox");
          await page.getByRole("button", { name: "New temporary inbox" }).first().click();
          await page.getByRole("table", { name: "Inboxes" }).getByRole("row").nth(1).waitFor();
        });
        const [inbox] = yield* api(page, "/v1/inboxes", Inboxes);
        const address = inbox?.address ?? "";
        expect(inbox).toEqual({
          address: expect.stringMatching(/^[a-z0-9]+@tmp\.test$/),
          isTemporary: true,
        });
        // The new inbox is opened right away, in the URL.
        expect(new URL(page.url()).searchParams.get("inbox")).toBe(address);

        const stored = yield* smtp({
          from: '"Example Login" <no-reply@login.example>',
          to: address,
          subject: "Your sign-in code",
          text: "Use this verification code to sign in: 482913",
        }).pipe(Effect.flatMap(Pipeline.handle));
        expect(stored).toEqual([{ _tag: "Stored" }]);

        // The list refreshes on its own; the code is shown with a copy button.
        const messages = page.getByRole("table", { name: "Messages" });
        yield* ui(async () => {
          await messages
            .getByRole("row", { name: /Your sign-in code/ })
            .waitFor({ timeout: 15_000 });
          await messages.getByRole("button", { name: "Copy code" }).waitFor();
          await messages.getByRole("row", { name: /Your sign-in code/ }).click();
        });
        const sheet = page.getByRole("dialog", { name: "Your sign-in code" });
        const shown = yield* ui(async () => {
          await sheet.getByText("482913").first().waitFor();
          return sheet.textContent();
        });
        expect(shown).toContain("Example Login");
        expect(new URL(page.url()).searchParams.get("message")).toMatch(/^msg_/);

        yield* ui(async () => {
          await sheet.getByRole("button", { name: "Delete message" }).click();
          await sheet.waitFor({ state: "detached" });
          await page
            .getByRole("table", { name: "Inboxes" })
            .getByRole("button", { name: `Delete ${address}` })
            .click();
          await page.getByRole("heading", { name: "No inboxes yet" }).waitFor();
        });
        expect(yield* api(page, "/v1/inboxes", Inboxes)).toEqual([]);
      }),
    );
  });
});
