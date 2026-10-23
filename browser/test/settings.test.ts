import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import { goTo, layer, openPage, signUp, ui } from "./support/browser.ts";

describe("sessions and passkeys in Settings", () => {
  it.layer(layer, { timeout: 60_000 })((it) => {
    // SR-25 (PLAN.md §20.25): sessions can be seen and ended from the app.
    it.effect("lists the passkey and the sessions, and signs out everywhere else", () =>
      Effect.gen(function* () {
        const laptop = yield* openPage();
        yield* signUp(laptop.page, "ada");
        // The same passkey on a second browser, as a synced passkey would be.
        const [passkey] = yield* laptop.passkeys();
        expect(passkey).toBeDefined();
        const phone = yield* openPage();
        yield* Effect.forEach([passkey].filter(P.isNotUndefined), phone.addPasskey, {
          concurrency: 1,
        });
        yield* ui(async () => {
          await phone.page.goto("/");
          await phone.page.getByRole("button", { name: "Log in with a passkey" }).click();
          await phone.page.getByRole("button", { name: "Log out" }).waitFor();
        });

        yield* ui(async () => {
          await goTo(laptop.page, "Settings");
          const passkeys = laptop.page.getByRole("region", { name: "Passkeys" });
          await passkeys.getByText(/^Passkey added/).waitFor();
          await passkeys.getByText(/Last used/).waitFor();
          const sessions = laptop.page.getByRole("region", { name: "Sessions" });
          await sessions.getByText("This browser").waitFor();
          await sessions.getByRole("listitem").nth(1).waitFor();
          await sessions.getByRole("button", { name: "Sign out everywhere else" }).click();
          await sessions.getByRole("button", { name: "Sign out everywhere else" }).waitFor({
            state: "detached",
          });
        });
        const sessions = laptop.page.getByRole("region", { name: "Sessions" });
        expect(yield* Effect.promise(() => sessions.getByRole("listitem").count())).toBe(1);

        // The phone's session is gone; the laptop's stays.
        const phoneMe = yield* Effect.promise(() => phone.page.request.get("/v1/me"));
        expect(phoneMe.status()).toBe(401);
        const laptopMe = yield* Effect.promise(() => laptop.page.request.get("/v1/me"));
        expect(laptopMe.status()).toBe(200);
      }),
    );
  });
});
