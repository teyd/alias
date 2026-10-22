import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { api, goTo, layer, openPage, signUp, ui } from "./support/browser.ts";

const Domains = Schema.Array(
  Schema.Struct({
    domain: Schema.String,
    status: Schema.String,
    records: Schema.Array(Schema.Struct({ type: Schema.String, name: Schema.String })),
  }),
);

describe("custom domains in the web app", () => {
  it.layer(layer, { timeout: 60_000 })((it) => {
    it.effect("adds a custom domain and lists the DNS records to publish", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        yield* signUp(page, "ines");
        const records = page.getByRole("table", { name: "DNS records for shop.example" });

        yield* ui(async () => {
          await goTo(page, "Domains");
          // The empty state offers the same button again.
          await page.getByRole("button", { name: "Add domain" }).first().click();
          const dialog = page.getByRole("dialog", { name: "Add a custom domain" });
          await dialog.getByRole("textbox", { name: "Domain" }).fill("shop.example");
          await dialog.getByRole("button", { name: "Add domain" }).click();
          await dialog.waitFor({ state: "detached" });
          await records.waitFor();
        });

        // What the page shows is what the API stored: a pending domain with its records, the MX
        // to SES and the three Easy DKIM CNAMEs among them.
        const [stored, ...others] = yield* api(page, "/v1/domains", Domains);
        expect(others).toEqual([]);
        expect(stored).toMatchObject({ domain: "shop.example", status: "pending" });
        const rows = stored?.records ?? [];
        expect(rows.filter((record) => record.type === "MX")).not.toEqual([]);
        expect(rows.filter((record) => record.name.includes("._domainkey."))).toHaveLength(3);
        const shown = yield* ui(() => records.getByRole("row").count());
        // One header row, then one row per record.
        expect(shown).toBe(rows.length + 1);
        yield* ui(() =>
          records
            .getByRole("row", { name: "inbound-smtp.eu-west-1.amazonaws.com" })
            .first()
            .waitFor(),
        );
      }),
    );
  });
});
