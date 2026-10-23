import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { WebApp, inviteLayer, openPage, ui } from "./support/browser.ts";

describe("signing up with an invite code (PLAN.md §20.36)", () => {
  it.layer(inviteLayer, { timeout: 60_000 })((it) => {
    it.effect("asks for an invite code, takes one from the link, and only once", () =>
      Effect.gen(function* () {
        const code = Option.getOrElse((yield* WebApp).inviteCode, () => "");
        const { page } = yield* openPage();

        yield* ui(async () => {
          await page.goto("/register");
          await page.getByRole("textbox", { name: "Username" }).fill("ada");
          await page.getByRole("textbox", { name: "Invite code" }).fill("BCDF-GHJK-LMNP-QRST-VWXZ");
          await page.getByRole("button", { name: "Create passkey" }).click();
          await page
            .getByRole("alert")
            .filter({ hasText: "That invite code isn't valid, or it was used up or expired." })
            .waitFor();
        });

        // An invitation link fills the code in.
        yield* ui(async () => {
          await page.goto(`/register?invite=${code}`);
          await page.getByRole("textbox", { name: "Username" }).fill("ada");
        });
        expect(
          yield* ui(() => page.getByRole("textbox", { name: "Invite code" }).inputValue()),
        ).toBe(code);
        yield* ui(async () => {
          await page.getByRole("button", { name: "Create passkey" }).click();
          await page.getByRole("button", { name: "Log out" }).waitFor();
        });

        // The code was single-use.
        const other = yield* openPage();
        yield* ui(async () => {
          await other.page.goto(`/register?invite=${code}`);
          await other.page.getByRole("textbox", { name: "Username" }).fill("grace");
          await other.page.getByRole("button", { name: "Create passkey" }).click();
          await other.page
            .getByRole("alert")
            .filter({ hasText: "That invite code isn't valid, or it was used up or expired." })
            .waitFor();
        });
      }),
    );
  });
});
