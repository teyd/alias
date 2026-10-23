import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { api, goTo, layer, openPage, signUp, ui } from "./support/browser.ts";

const Domains = Schema.Array(
  Schema.Struct({
    domain: Schema.String,
    status: Schema.String,
    records: Schema.Array(
      Schema.Struct({
        isRequired: Schema.Boolean,
        type: Schema.String,
        name: Schema.String,
        value: Schema.String,
      }),
    ),
  }),
);

describe("custom domains in the web app", () => {
  it.layer(layer, { timeout: 60_000 })((it) => {
    it.effect("adds a custom domain, lists the required records and offers the zone file", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        yield* signUp(page, "ines");
        const card = page.getByLabel("shop.example", { exact: true });
        const required = page.getByRole("table", { name: "Required DNS records for shop.example" });
        const recommended = page.getByRole("table", {
          name: "Recommended DNS records for shop.example",
        });
        const optional = page.getByRole("button", {
          name: "Optional: better deliverability (3 records)",
        });

        yield* ui(async () => {
          await goTo(page, "Domains");
          // The empty state offers the same button again.
          await page.getByRole("button", { name: "Add domain" }).first().click();
          const dialog = page.getByRole("dialog", { name: "Add a custom domain" });
          await dialog.getByRole("textbox", { name: "Domain" }).fill("shop.example");
          await dialog.getByRole("button", { name: "Add domain" }).click();
          await dialog.waitFor({ state: "detached" });
          await required.waitFor();
        });

        // What the page shows is what the API stored: a pending domain with its records, the MX
        // to SES and the three Easy DKIM CNAMEs among them.
        const [stored, ...others] = yield* api(page, "/v1/domains", Domains);
        expect(others).toEqual([]);
        expect(stored).toMatchObject({ domain: "shop.example", status: "pending" });
        const rows = stored?.records ?? [];
        expect(rows.filter((record) => record.type === "MX")).not.toEqual([]);
        expect(rows.filter((record) => record.name.includes("._domainkey."))).toHaveLength(3);
        expect(rows.filter((record) => record.isRequired)).toHaveLength(5);
        expect(rows.filter((record) => !record.isRequired)).toHaveLength(3);

        // Only the five required records show up front; the recommended ones are folded away.
        yield* ui(() => card.getByText("Publish these 5 records").waitFor());
        // One header row, then one row per required record.
        expect(yield* ui(() => required.getByRole("row").count())).toBe(6);
        yield* ui(() =>
          required
            .getByRole("row", { name: "inbound-smtp.eu-west-1.amazonaws.com" })
            .first()
            .waitFor(),
        );
        expect(yield* ui(() => optional.getAttribute("aria-expanded"))).toBe("false");
        expect(yield* ui(() => recommended.count())).toBe(0);
        yield* ui(async () => {
          await optional.click();
          await recommended.waitFor();
        });
        expect(yield* ui(() => optional.getAttribute("aria-expanded"))).toBe("true");
        expect(yield* ui(() => recommended.getByRole("row").count())).toBe(4);

        // The zone file holds all eight, required first, as absolute BIND lines.
        const download = yield* ui(async () => {
          const [started] = await Promise.all([
            page.waitForEvent("download"),
            card.getByRole("button", { name: "Download zone file" }).click(),
          ]);
          return { name: started.suggestedFilename(), bytes: await started.createReadStream() };
        });
        expect(download.name).toBe("shop.example.zone");
        const zone = yield* Stream.fromAsyncIterable(download.bytes, (cause) => cause).pipe(
          Stream.map((chunk: Uint8Array) => chunk),
          Stream.decodeText(),
          Stream.mkString,
        );
        const lines = zone.split("\n").filter((line) => line !== "" && !line.startsWith(";"));
        const data = (record: (typeof rows)[number]) =>
          record.type === "TXT"
            ? `"${record.value}"`
            : record.type === "MX"
              ? `10 ${record.value}.`
              : `${record.value}.`;
        expect(lines.map((line) => line.split(" ; ")[0])).toEqual(
          [...rows.filter((r) => r.isRequired), ...rows.filter((r) => !r.isRequired)].map(
            (record) => `${record.name}.\t3600\tIN\t${record.type}\t${data(record)}`,
          ),
        );
      }),
    );
  });
});
