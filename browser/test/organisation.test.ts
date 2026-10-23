import { sentTo } from "@alias/e2e/stack";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Page } from "playwright";
import { WebApp, api, goTo, layer, openPage, signUp, ui } from "./support/browser.ts";

/** Organising aliases in the web app (PLAN.md §20.31). */

const Aliases = Schema.Array(
  Schema.Struct({
    address: Schema.String,
    description: Schema.optionalKey(Schema.String),
    labels: Schema.Array(Schema.String),
    recipientIds: Schema.Array(Schema.String),
  }),
);
const Created = Schema.Struct({ id: Schema.String });

const table = (page: Page) => page.getByRole("table", { name: "Aliases" });
const row = (page: Page, address: string) => table(page).getByRole("row", { name: address });

/** A change through the API with the page's session, as the app itself would send it. */
const post = (page: Page, path: string, data: Schema.Json) =>
  Effect.flatMap(Effect.service(WebApp), ({ origin }) =>
    Effect.promise(() =>
      page.request
        .post(path, { data, headers: { origin } })
        .then(async (response) => ({ status: response.status(), body: await response.json() })),
    ),
  );

/** Adds `address` as a destination and confirms it with the token from its mail. */
const verifiedDestination = Effect.fn("verifiedDestination")(function* (
  page: Page,
  address: string,
) {
  const added = yield* post(page, "/v1/recipients", { address });
  const { id } = Schema.decodeUnknownSync(Created)(added.body);
  const [mail] = yield* sentTo(address);
  const link = new URL(/https?:\/\/\S+\/destinations\?\S+/.exec(mail?.text ?? "")?.[0] ?? "x:");
  const token = Option.getOrElse(Option.fromNullOr(link.searchParams.get("token")), () => "");
  expect((yield* post(page, `/v1/recipients/${id}/confirm`, { token })).status).toBe(200);
  return id;
});

const createAlias = (page: Page, address: string) =>
  Effect.tap(post(page, "/v1/aliases", { _tag: "Address", address, mode: "forward" }), (created) =>
    Effect.sync(() => expect(created.status).toBe(201)),
  );

/** Opens the "Edit alias" dialog from the alias's row menu. */
const edit = async (page: Page, address: string) => {
  await row(page, address).getByRole("button", { name: "Alias actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  return page.getByRole("dialog", { name: "Edit alias" });
};

describe("organising aliases in the web app", () => {
  it.layer(layer, { timeout: 60_000 })((it) => {
    it.effect("describes and labels aliases, filters and searches them, and exports CSV", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        yield* signUp(page, "eve");
        yield* createAlias(page, "shop@eve.alias.test");
        yield* createAlias(page, "club@eve.alias.test");

        yield* ui(async () => {
          await goTo(page, "Aliases");
          const dialog = await edit(page, "shop@eve.alias.test");
          await dialog.getByRole("textbox", { name: "Description" }).fill("=1+1 Online shop");
          // A label with a comma inside can't be one: the field says so before saving.
          await dialog.getByRole("textbox", { name: "Labels" }).fill("shopping, eu;x");
          await dialog.getByRole("alert").waitFor();
          await dialog.getByRole("textbox", { name: "Labels" }).fill("shopping, eu");
          await dialog.getByRole("button", { name: "Save alias" }).click();
          await dialog.waitFor({ state: "detached" });
          const club = await edit(page, "club@eve.alias.test");
          await club.getByRole("textbox", { name: "Labels" }).fill("newsletters");
          await club.getByRole("button", { name: "Save alias" }).click();
          await club.waitFor({ state: "detached" });
          await row(page, "shop@eve.alias.test").getByText("=1+1 Online shop").waitFor();
        });
        const stored = yield* api(page, "/v1/aliases", Aliases);
        expect(
          Arr.map(stored, ({ address, description, labels }) => ({ address, description, labels })),
        ).toEqual([
          {
            address: "shop@eve.alias.test",
            description: "=1+1 Online shop",
            labels: ["shopping", "eu"],
          },
          { address: "club@eve.alias.test", labels: ["newsletters"] },
        ]);

        // Filter by label, then search by description.
        yield* ui(async () => {
          await page.getByRole("combobox", { name: "Filter by label" }).click();
          await page.getByRole("option", { name: "newsletters" }).click();
          await row(page, "shop@eve.alias.test").waitFor({ state: "detached" });
          await row(page, "club@eve.alias.test").waitFor();
          await page.getByRole("combobox", { name: "Filter by label" }).click();
          await page.getByRole("option", { name: "All labels" }).click();
          await page.getByRole("searchbox", { name: "Search aliases" }).fill("online");
          await row(page, "club@eve.alias.test").waitFor({ state: "detached" });
          await row(page, "shop@eve.alias.test").waitFor();
        });
        expect(new URL(page.url()).searchParams.get("q")).toBe("online");

        // Label colours.
        yield* ui(async () => {
          await page.getByRole("button", { name: "Labels" }).click();
          const dialog = page.getByRole("dialog", { name: "Labels" });
          await dialog.getByRole("combobox", { name: "Colour of shopping" }).click();
          await page.getByRole("option", { name: "blue" }).click();
          await dialog
            .getByRole("combobox", { name: "Colour of shopping" })
            .getByText("blue")
            .waitFor();
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "detached" });
        });
        const Labels = Schema.Array(
          Schema.Struct({ name: Schema.String, color: Schema.optionalKey(Schema.String) }),
        );
        expect(yield* api(page, "/v1/labels", Labels)).toEqual([
          { name: "eu" },
          { name: "newsletters" },
          { name: "shopping", color: "blue" },
        ]);

        // The export is CSV a spreadsheet can't run as a formula.
        const download = yield* ui(async () => {
          const [started] = await Promise.all([
            page.waitForEvent("download"),
            page.getByRole("button", { name: "Export CSV" }).click(),
          ]);
          return { name: started.suggestedFilename(), bytes: await started.createReadStream() };
        });
        expect(download.name).toBe("aliases.csv");
        const csv = yield* Stream.fromAsyncIterable(download.bytes, (cause) => cause).pipe(
          Stream.map((chunk: Uint8Array) => chunk),
          Stream.decodeText(),
          Stream.mkString,
        );
        const lines = csv.split("\r\n");
        expect(lines[0]).toBe(
          "address,active,mode,description,labels,recipients,forwarded,blocked,created_at",
        );
        expect(lines[1]).toMatch(
          /^shop@eve\.alias\.test,true,forward,'=1\+1 Online shop,shopping; eu,,0,0,\d{4}-/,
        );
        expect(lines[2]).toMatch(/^club@eve\.alias\.test,true,forward,,newsletters,,0,0,/);
      }),
    );

    it.effect("forwards an alias to the destinations chosen for it", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        yield* signUp(page, "finn");
        const home = yield* verifiedDestination(page, "finn@home.example");
        const work = yield* verifiedDestination(page, "finn@work.example");
        yield* createAlias(page, "shop@finn.alias.test");

        yield* ui(async () => {
          await goTo(page, "Aliases");
          const dialog = await edit(page, "shop@finn.alias.test");
          await dialog.getByText("Default destination (finn@home.example).").waitFor();
          await dialog.getByRole("switch", { name: "Forward to finn@work.example" }).click();
          await dialog.getByRole("switch", { name: "Forward to finn@home.example" }).click();
          await dialog.getByRole("button", { name: "Save alias" }).click();
          await dialog.waitFor({ state: "detached" });
        });
        expect(yield* api(page, "/v1/aliases", Aliases)).toEqual([
          expect.objectContaining({ recipientIds: [work, home] }),
        ]);

        // Stored: the dialog shows both chosen after a reload, and turning them off goes back
        // to the default.
        yield* ui(async () => {
          await page.reload();
          const dialog = await edit(page, "shop@finn.alias.test");
          await dialog
            .getByRole("switch", { name: "Forward to finn@work.example", checked: true })
            .click();
          await dialog
            .getByRole("switch", { name: "Forward to finn@home.example", checked: true })
            .click();
          await dialog.getByRole("button", { name: "Save alias" }).click();
          await dialog.waitFor({ state: "detached" });
        });
        expect(yield* api(page, "/v1/aliases", Aliases)).toEqual([
          expect.objectContaining({ recipientIds: [] }),
        ]);
      }),
    );

    it.effect("imports a CSV file and says what became of each row", () =>
      Effect.gen(function* () {
        const { page } = yield* openPage();
        yield* signUp(page, "gil");
        const file = [
          "address,description,labels",
          "shop@gil.alias.test,Online shop,shopping;eu",
          "random@alias.test,,",
          "",
        ].join("\r\n");

        yield* ui(async () => {
          await goTo(page, "Aliases");
          await page.getByRole("button", { name: "Import" }).click();
          const dialog = page.getByRole("dialog", { name: "Import aliases" });
          await dialog.getByLabel("CSV file").setInputFiles({
            name: "aliases.csv",
            mimeType: "text/csv",
            buffer: Buffer.from(file),
          });
          const results = dialog.getByRole("list", { name: "Import results" });
          await results
            .getByRole("listitem")
            .filter({ hasText: "shop@gil.alias.test" })
            .getByText("Created")
            .waitFor();
          await results
            .getByRole("listitem")
            .filter({ hasText: "random@alias.test" })
            .getByText("Shared domains only get random addresses.")
            .waitFor();
          await page.keyboard.press("Escape");
          await row(page, "shop@gil.alias.test").waitFor();
        });
        expect(yield* api(page, "/v1/aliases", Aliases)).toEqual([
          {
            address: "shop@gil.alias.test",
            description: "Online shop",
            labels: ["shopping", "eu"],
            recipientIds: [],
          },
        ]);
      }),
    );
  });
});
