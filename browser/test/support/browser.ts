import { apiHandler, mintInvite, sentTo, layer as stackLayer } from "@alias/e2e/stack";
import { FunctionUrlServer } from "@alias/lambda-emulator";
import { TurnstileServer } from "@alias/turnstile-emulator";
import { securityHeaders } from "@alias/web/security-headers";
import { NodeServices } from "@effect/platform-node";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import { build, preview } from "vite-plus";

/**
 * The web app as a browser reaches it: `http://localhost:<port>`, a secure context. While sign-up
 * takes invite codes (PLAN.md §20.36), `inviteCode` is a single-use one minted for the file.
 */
export class WebApp extends Context.Service<
  WebApp,
  { readonly origin: string; readonly inviteCode: Option.Option<string> }
>()("@alias/browser/WebApp") {}

class Chromium extends Context.Service<Chromium, Browser>()("@alias/browser/Chromium") {}

/**
 * The production bundle of `apps/web`, built into a temp dir and served by `vite preview` with
 * production's security headers (`@alias/web/security-headers`), which forwards `/v1`, `/health`
 * and `/.well-known` to the API's function URL, as the CloudFront distribution does.
 *
 * Browsers treat `http://localhost` as a secure context, so the API's `Secure` session cookie and
 * WebAuthn work there without TLS. The passkey's relying party is `localhost` and its origin the
 * preview server's, which is only known once it listens; the function URL server starts first and
 * waits for the handler, so every listener still binds port 0.
 *
 * Sign-up is open unless `signupMode` is `invite`.
 */
const webApp = (signupMode: "open" | "invite") =>
  Layer.effectContext(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.dirname(
        yield* path.fromFileUrl(new URL(import.meta.resolve("@alias/web/package.json"))),
      );
      const configFile = path.join(root, "vite.config.ts");
      const outDir = yield* fs.makeTempDirectoryScoped({ prefix: "alias-web-" });
      yield* Effect.promise(() =>
        build({ root, configFile, logLevel: "warn", build: { outDir, emptyOutDir: true } }),
      );

      const turnstile = yield* TurnstileServer.TurnstileServer;
      const handler = yield* Deferred.make<Effect.Success<ReturnType<typeof apiHandler>>>();
      const api = yield* FunctionUrlServer.make({
        handler: (event) =>
          Effect.runPromise(
            Deferred.await(handler).pipe(
              Effect.flatMap((handle) => Effect.promise(() => handle(event))),
            ),
          ),
      });

      const server = yield* Effect.acquireRelease(
        Effect.promise(() =>
          preview({
            root,
            configFile,
            logLevel: "warn",
            build: { outDir },
            preview: {
              host: "127.0.0.1",
              port: 0,
              strictPort: true,
              // As CloudFront routes them; `/.well-known` has the OAuth metadata (§20.24).
              proxy: { "/v1": api.url, "/health": api.url, "/.well-known": api.url },
              // Production's headers, with the Turnstile emulator where Cloudflare would be.
              headers: securityHeaders(turnstile.url),
            },
          }),
        ),
        (running) => Effect.promise(() => running.close()),
      );
      const { port } = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }))(
        server.httpServer.address(),
      );
      const origin = `http://localhost:${port}`;

      yield* Deferred.succeed(
        handler,
        yield* apiHandler({ id: "localhost", origin }, undefined, undefined, signupMode),
      );
      const inviteCode =
        signupMode === "invite" ? Option.some(yield* mintInvite) : Option.none<string>();
      return Context.make(WebApp, WebApp.of({ origin, inviteCode })).pipe(
        Context.add(
          FunctionUrlServer.FunctionUrlServer,
          FunctionUrlServer.FunctionUrlServer.of(api),
        ),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer));

/**
 * Headless Chromium, one per test file. `vp run` (behind `pnpm test`) traces the files a task
 * reads by injecting a library into every process it starts, whatever their environment; in
 * Chromium's separate GPU process that stops frames from being drawn, so every click would wait
 * forever for the page to settle. `--in-process-gpu` runs the GPU thread in the browser process.
 */
const chromiumLayer = Layer.effect(
  Chromium,
  Effect.acquireRelease(
    Effect.promise(() => chromium.launch({ headless: true, args: ["--in-process-gpu"] })),
    (browser) => Effect.promise(() => browser.close()),
  ),
);

/** The emulated stack (`@alias/e2e/stack`) with the web app in front. */
export const stack = stackLayer(webApp("open"));

/** {@link stack} and a browser to drive it. */
export const layer = Layer.merge(stack, chromiumLayer);

/** {@link layer} with sign-up taking invite codes, as in the private beta (PLAN.md §20.36). */
export const inviteLayer = Layer.merge(stackLayer(webApp("invite")), chromiumLayer);

/**
 * A virtual WebAuthn authenticator on `page`, attached over CDP: a platform authenticator
 * (CTAP2, internal transport) that stores discoverable credentials and verifies the user without
 * a prompt, like Touch ID that always says yes.
 */
export const attachAuthenticator = Effect.fn("browser.attachAuthenticator")(function* (
  context: BrowserContext,
  page: Page,
) {
  const cdp = yield* Effect.promise(() => context.newCDPSession(page));
  yield* Effect.promise(() => cdp.send("WebAuthn.enable"));
  const { authenticatorId } = yield* Effect.promise(() =>
    cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    }),
  );
  /** The passkeys the authenticator holds. */
  const passkeys = () =>
    Effect.promise(() => cdp.send("WebAuthn.getCredentials", { authenticatorId })).pipe(
      Effect.map(({ credentials }) => credentials),
    );
  /** Gives this authenticator a copy of another one's passkey, as a synced passkey would arrive. */
  const addPasskey = (credential: Effect.Success<ReturnType<typeof passkeys>>[number]) =>
    Effect.promise(() => cdp.send("WebAuthn.addCredential", { authenticatorId, credential }));
  return { passkeys, addPasskey };
});

/** A fresh browser profile on the web app, with a virtual WebAuthn authenticator attached. */
export const openPage = Effect.fn("browser.openPage")(function* (
  options: {
    /**
     * For pages that aren't the app (an emulator's probe page put on the app's origin): ignore
     * the app's CSP instead of failing on it.
     */
    readonly isCspBypassed?: boolean;
  } = {},
) {
  const browser = yield* Chromium;
  const { origin } = yield* WebApp;
  // The app runs under production's CSP (`vite preview` sends it); a violation fails the test.
  const violations: Array<string> = [];
  const context: BrowserContext = yield* Effect.acquireRelease(
    Effect.promise(() =>
      browser.newContext({ baseURL: origin, bypassCSP: options.isCspBypassed ?? false }),
    ),
    (opened) =>
      Effect.promise(() => opened.close()).pipe(
        Effect.andThen(
          Arr.isReadonlyArrayEmpty(violations)
            ? Effect.void
            : Effect.die(`Content-Security-Policy violations: ${violations.join(" | ")}`),
        ),
      ),
  );
  context.setDefaultTimeout(10_000);
  const page: Page = yield* Effect.promise(() => context.newPage());
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  const { passkeys, addPasskey } = yield* attachAuthenticator(context, page);
  return { page, context, passkeys, addPasskey };
});

/** Runs a few steps in the browser; Playwright's locators wait for the page on their own. */
export const ui = <A>(steps: () => Promise<A>) => Effect.promise(steps);

/** Signs up on the web app with a new passkey from the page's authenticator. */
export const signUp = (page: Page, username: string) =>
  ui(async () => {
    await page.goto("/register");
    await page.getByRole("textbox", { name: "Username" }).fill(username);
    await page.getByRole("button", { name: "Create passkey" }).click();
    await page.getByRole("button", { name: "Log out" }).waitFor();
  });

/** What the API says, read with the page's own session cookie. */
export const api = <S extends Schema.Top>(page: Page, path: string, schema: S) =>
  Effect.promise(() => page.request.get(path).then((response) => response.json())).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
  );

/** Follows an entry of the app's sidebar ("Overview", "Aliases", "Destinations", …). */
export const goTo = (page: Page, entry: string) =>
  page.getByRole("navigation").getByRole("link", { name: entry, exact: true }).click();

/**
 * Adds `mailbox` as a destination on the Destinations screen and confirms it from the link in the
 * confirmation mail SES sent (read on fakecloud), as its owner would.
 */
export const confirmDestination = Effect.fn("browser.confirmDestination")(function* (
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
  const confirmations = Arr.filter(yield* sentTo(mailbox), (email) =>
    email.text.includes(`${origin}/destinations?`),
  );
  const link = new RegExp(`${origin}/destinations\\?\\S+`).exec(
    Arr.last(confirmations).pipe(
      Option.map((email) => email.text),
      Option.getOrElse(() => ""),
    ),
  );
  yield* ui(async () => {
    await page.goto(link?.[0] ?? "/");
    const confirm = page.getByRole("button", { name: "Confirm this address" });
    await confirm.click();
    await confirm.waitFor({ state: "detached" });
  });
});
