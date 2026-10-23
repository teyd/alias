// A real sign-up page on its own site is the point: the extension fills a field in another tab.
// oxlint-disable-next-line effect/avoid-node-imports, effect/use-http-client-service
import { createServer } from "node:http";
import { buildExtension } from "@alias/extension/build";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { type BrowserContext, chromium } from "playwright";
import { WebApp } from "./browser.ts";

/**
 * The browser extension (`apps/extension`, PLAN.md §20.35) loaded unpacked into Chromium, signed
 * in to nothing yet, its server the web app. Extensions need a persistent profile and Chromium's
 * new headless mode (the full browser, `channel: "chromium"`); the headless shell the other
 * browser tests use can't load them.
 */

/** A sign-up form on a site of its own, which Chromium resolves to the server below. */
const SITE_HOST = "shop.example.co.uk";

const SIGN_UP_PAGE = `<!doctype html>
<title>Sign up</title>
<form>
  <label>Email <input type="email" name="email" autocomplete="email"></label>
  <label>Name <input type="text" name="name"></label>
</form>
<script>
  // What a framework sees: the value its input listener got, not just the DOM property.
  const email = document.querySelector('input[name="email"]');
  email.addEventListener("input", () => { document.body.dataset.typed = email.value; });
</script>`;

/** The sign-up page on 127.0.0.1, port 0; its origin as Chromium reaches it. */
const signUpSite = Effect.acquireRelease(
  Effect.callback<ReturnType<typeof createServer>>((resume) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(SIGN_UP_PAGE);
    });
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.flatMap((server) =>
    Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }))(server.address()),
  ),
  Effect.map(({ port }) => `http://${SITE_HOST}:${port}`),
);

/** The extension's ID, from its service worker's URL. */
const extensionId = (context: BrowserContext) =>
  Effect.promise(async () => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    return new URL(worker.url()).host;
  });

export const openExtension = Effect.fn("extension.open")(function* () {
  const { origin } = yield* WebApp;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const site = yield* signUpSite;
  const outDir = yield* fs.makeTempDirectoryScoped({ prefix: "alias-extension-" });
  const profile = yield* fs.makeTempDirectoryScoped({ prefix: "alias-profile-" });
  const unpacked = path.join(outDir, "chromium");
  yield* Effect.promise(() =>
    buildExtension({
      target: "chromium",
      outDir: unpacked,
      server: origin,
      // Tests can't click the toolbar button or the context menu, the gestures that grant
      // `activeTab`, so the sign-up site is granted at install instead.
      extraHostOrigins: [`http://${SITE_HOST}`],
    }),
  );
  const context = yield* Effect.acquireRelease(
    Effect.promise(() =>
      chromium.launchPersistentContext(profile, {
        channel: "chromium",
        headless: true,
        baseURL: origin,
        args: [
          `--disable-extensions-except=${unpacked}`,
          `--load-extension=${unpacked}`,
          `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1`,
          // See `chromiumLayer` in `browser.ts`.
          "--in-process-gpu",
        ],
      }),
    ),
    (opened) => Effect.promise(() => opened.close()),
  );
  context.setDefaultTimeout(10_000);
  const id = yield* extensionId(context);
  return { context, site, popupUrl: `chrome-extension://${id}/popup.html` };
}, Effect.provide(NodeServices.layer));
