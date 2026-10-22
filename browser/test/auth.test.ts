import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { goTo, layer, openPage, signUp, ui } from "./support/browser.ts";

describe("signing in with a passkey", () => {
  it.layer(layer, { timeout: 60_000 })((it) => {
    it.effect("signs up with a new passkey, signs out, and signs in again with it", () =>
      Effect.gen(function* () {
        const { page, context, passkeys } = yield* openPage();

        yield* ui(async () => {
          await page.goto("/");
          await page.getByRole("link", { name: "Create an account" }).click();
          await page.getByRole("textbox", { name: "Username" }).fill("ada");
          await page.getByRole("button", { name: "Create passkey" }).click();
          await page.getByRole("button", { name: "Log out" }).waitFor();
        });
        // One discoverable passkey for `localhost`, and a session cookie that keeps its flags
        // over plain http://localhost.
        const [passkey, ...others] = yield* passkeys();
        expect(others).toEqual([]);
        expect(passkey).toMatchObject({ rpId: "localhost", isResidentCredential: true });
        const cookies = yield* Effect.promise(() => context.cookies());
        expect(cookies).toEqual([
          expect.objectContaining({ secure: true, httpOnly: true, sameSite: "Strict" }),
        ]);

        // Signed in across a reload: the browser sends the cookie back.
        yield* ui(async () => {
          await page.reload();
          await page.getByRole("button", { name: "Log out" }).click();
          await page.getByRole("button", { name: "Log in with a passkey" }).waitFor();
        });
        expect(yield* Effect.promise(() => context.cookies())).toEqual([]);

        yield* ui(async () => {
          await page.getByRole("button", { name: "Log in with a passkey" }).click();
          await page.getByRole("button", { name: "Log out" }).waitFor();
        });
        expect(yield* passkeys()).toHaveLength(1);
      }),
    );

    it.effect("refuses a username that is already taken", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        yield* signUp(page, "grace");
        yield* ui(async () => {
          await page.getByRole("button", { name: "Log out" }).click();
          await page.goto("/register");
          await page.getByRole("textbox", { name: "Username" }).fill("grace");
          await page.getByRole("button", { name: "Create passkey" }).click();
          await page.getByRole("alert").filter({ hasText: "That username is taken." }).waitFor();
        });
      }),
    );

    it.effect(
      "deletes the account after confirming with the passkey, and keeps the username taken",
      () =>
        Effect.gen(function* () {
          const { page, context } = yield* openPage();
          yield* signUp(page, "hana");

          yield* ui(async () => {
            await goTo(page, "Settings");
            await page.getByRole("button", { name: "Delete account" }).click();
            // The passkey prompt is the confirmation; the virtual authenticator answers it.
            await page
              .getByRole("dialog", { name: "Delete your account for good?" })
              .getByRole("button", { name: "Confirm with passkey" })
              .click();
            await page.getByRole("button", { name: "Log in with a passkey" }).waitFor();
          });
          expect(yield* Effect.promise(() => context.cookies())).toEqual([]);
          const me = yield* Effect.promise(() => page.request.get("/v1/me"));
          expect(me.status()).toBe(401);

          // The browser still holds the passkey, but the account it belonged to is gone.
          yield* ui(async () => {
            await page.getByRole("button", { name: "Log in with a passkey" }).click();
            await page
              .getByRole("alert")
              .filter({ hasText: "This passkey isn't registered here." })
              .waitFor();
          });

          // Nobody can take the username over.
          yield* ui(async () => {
            await page.goto("/register");
            await page.getByRole("textbox", { name: "Username" }).fill("hana");
            await page.getByRole("button", { name: "Create passkey" }).click();
            await page.getByRole("alert").filter({ hasText: "That username is taken." }).waitFor();
          });
        }),
    );
  });
});
