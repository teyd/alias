import { TestApi } from "@alias/api/testing";
import { AliasRepo, ContactRepo } from "@alias/db";
import { Inbox } from "@alias/inbox";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { CLI_SCOPES, alias } from "../src/Commands.ts";
import * as Credentials from "../src/Credentials.ts";

/** What the CLI printed, line by line: `out` from `Console.log`, `err` from `Console.error`. */
const captured = () => {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const console: Console.Console = {
    ...globalThis.console,
    log: (...args) => void out.push(Arr.join(Arr.map(args, String), " ")),
    error: (...args) => void err.push(Arr.join(Arr.map(args, String), " ")),
  };
  return { out, err, console };
};

/** Runs `alias …` with its own config directory, environment and captured console. */
const cli = (
  args: ReadonlyArray<string>,
  configDir: string,
  output: ReturnType<typeof captured>,
  env: Readonly<Record<string, string>> = {},
) =>
  Command.runWith(alias, { version: "test" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        Credentials.layer.pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        FetchHttpClient.layer,
      ),
    ),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ ALIAS_CONFIG_DIR: configDir, ...env })),
    ),
    Effect.provideService(Console.Console, output.console),
    Effect.exit,
  );

/**
 * The API Lambda behind the function URL emulator on fakecloud, Ada signed in in a browser, and a
 * way to run `alias …` against it in a fresh config directory.
 */
const setUp = Effect.fn("setUp")(function* () {
  const api = yield* TestApi.served;
  const ada = yield* TestApi.signedIn(api.browser, "ada");
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = path.join(yield* fs.makeTempDirectoryScoped(), "alias");
  const run = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) => {
    const output = captured();
    return Effect.map(cli(args, configDir, output, env), (exit) => ({
      exit,
      ...output,
      text: Arr.join(output.out, "\n"),
    }));
  };
  return { api, ada, configDir, run };
});

/**
 * Starts `alias login` in the background and waits (in real time: the API answers over real
 * HTTP) until it shows the user code.
 */
const startLogin = Effect.fn("startLogin")(function* (url: string, configDir: string) {
  const output = captured();
  const login = yield* Effect.forkChild(cli(["login", "--api-url", url], configDir, output));
  const shown = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10))).pipe(
    Effect.map(() =>
      Option.flatMap(
        Option.fromNullOr(/code ([B-Z]{4}-[B-Z]{4})/.exec(Arr.join(output.out, "\n"))),
        (match) => Option.fromUndefinedOr(match[1]),
      ),
    ),
  );
  const code = yield* shown.pipe(Effect.repeat({ until: Option.isSome, times: 500 }));
  return { login, output, code: Option.getOrElse(code, () => "") };
});

/** `alias login` end to end: the CLI prints the code, Ada approves it in her browser session. */
const loggedIn = Effect.fn("loggedIn")(function* () {
  const context = yield* setUp();
  const { login, output, code } = yield* startLogin(context.api.url, context.configDir);
  // The page is the web app's (the relying party's origin), which serves the API in production.
  expect(Arr.join(output.out, "\n")).toContain(`https://alias.test/device?code=${code}`);
  const approved = yield* context.ada.browser.post("/v1/device/approve", { userCode: code });
  expect(approved.status).toBe(204);
  // The CLI sleeps the RFC's 5-second interval on the test clock before it polls.
  yield* TestClock.adjust("5 seconds");
  expect(Exit.isSuccess(yield* Fiber.join(login))).toBe(true);
  return { ...context, login: output };
});

const Stored = Schema.Struct({
  apiUrl: Schema.String,
  username: Schema.String,
  token: Schema.String,
});

describe("alias CLI against the API on the function URL emulator", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("logs in with a device code, keeps the token in a 0600 file, and logs out", () =>
      Effect.gen(function* () {
        const { api, ada, configDir, login, run } = yield* loggedIn();
        expect(Arr.join(login.out, "\n")).toContain(`Logged in to ${api.url} as ada.`);

        const fs = yield* FileSystem.FileSystem;
        const file = `${configDir}/credentials.json`;
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
        expect((yield* fs.stat(configDir)).mode & 0o777).toBe(0o700);
        const stored = Schema.decodeUnknownSync(Schema.fromJsonString(Stored))(
          yield* fs.readFileString(file),
        );
        expect(stored).toMatchObject({ apiUrl: api.url, username: "ada" });
        expect(stored.token).toMatch(/^alias_pat_/);
        // The token has exactly the scopes the CLI asked for.
        expect((yield* ada.browser.get("/v1/tokens")).body).toMatchObject([
          { name: "Alias CLI (device login)", scopes: [...CLI_SCOPES] },
        ]);

        const whoami = yield* run(["whoami", "--json"]);
        expect(JSON.parse(whoami.text)).toEqual({ username: "ada", userId: ada.userId });

        const logout = yield* run(["logout"]);
        expect(logout.text).toBe("Logged out; the token is revoked.");
        expect((yield* api.withToken(stored.token).get("/v1/me")).status).toBe(401);
        const after = yield* run(["whoami"]);
        expect(Exit.isFailure(after.exit)).toBe(true);
        expect(Arr.join(after.err, "\n")).toContain("Not logged in. Run `alias login` first");
      }),
    );

    it.effect("manages aliases: create, list as a table and as JSON, disable, enable, delete", () =>
      Effect.gen(function* () {
        const { run } = yield* loggedIn();
        const created = yield* run(["aliases", "create"]);
        const address = Str.trim(created.text);
        expect(address).toMatch(/^[a-z0-9]+@alias\.test$/);

        const table = yield* run(["aliases", "list"]);
        expect(table.text.split("\n")).toEqual([
          expect.stringMatching(/^ADDRESS\s+ACTIVE\s+MODE\s+FORWARDED\s+BLOCKED$/),
          expect.stringMatching(new RegExp(`^${address}\\s+true\\s+forward\\s+0\\s+0$`)),
        ]);

        yield* run(["aliases", "disable", address]);
        const listed = yield* run(["aliases", "list", "--json"]);
        expect(JSON.parse(listed.text)).toEqual([
          {
            address,
            active: false,
            mode: "forward",
            forwarded: 0,
            blocked: 0,
            id: expect.any(String),
          },
        ]);
        yield* run(["aliases", "enable", address.toUpperCase()]);
        expect(JSON.parse((yield* run(["aliases", "ls", "--json"])).text)[0].active).toBe(true);

        const unconfirmed = yield* run(["aliases", "delete", address]);
        expect(Exit.isFailure(unconfirmed.exit)).toBe(true);
        expect(Arr.join(unconfirmed.err, "\n")).toContain("Pass --yes");
        expect((yield* run(["aliases", "delete", address, "--yes"])).text).toBe(
          `Deleted ${address}.`,
        );
        expect((yield* run(["aliases", "list"])).text).toBe("No aliases yet.");

        const missing = yield* run(["aliases", "disable", address]);
        expect(Arr.join(missing.err, "\n")).toContain(`No alias ${address}.`);
        const taken = yield* run([
          "aliases",
          "create",
          "--address",
          "shop@someone-else.alias.test",
        ]);
        expect(Exit.isFailure(taken.exit)).toBe(true);
      }),
    );

    it.effect("lists and blocks an alias's contacts, and lists forwarding addresses", () =>
      Effect.gen(function* () {
        const { api, run } = yield* loggedIn();
        const address = Str.trim((yield* run(["aliases", "create", "--json"])).text);
        const alias = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ address: Schema.String, id: Schema.String })),
        )(address);
        const [localPart = "", domain = ""] = alias.address.split("@");
        // Contacts appear when someone writes; the inbound Lambda's repository stands in for that.
        yield* ContactRepo.ContactRepo.pipe(
          Effect.flatMap((contacts) =>
            contacts.create(
              {
                id: "ct_1",
                aliasId: alias.id,
                address: "Shop@Example.com",
                name: Option.some("Shop"),
                createdAt: DateTime.makeUnsafe(0),
              },
              { domain, localPart },
            ),
          ),
          Effect.provide(ContactRepo.layer.pipe(Layer.provide(Layer.succeedContext(api.context)))),
        );

        const listed = yield* run(["contacts", "list", alias.address]);
        expect(listed.text.split("\n")[1]).toMatch(
          /^ct_1\s+Shop@Example\.com\s+Shop\s+false\s+1970/,
        );
        const blocked = yield* run(["contacts", "block", alias.address, "shop@example.com"]);
        expect(blocked.text).toBe(
          `Blocked Shop@Example.com: its mail to ${alias.address} is dropped.`,
        );
        expect(
          JSON.parse((yield* run(["contacts", "ls", alias.address, "--json"])).text)[0],
        ).toMatchObject({
          id: "ct_1",
          blocked: true,
        });
        yield* run(["contacts", "unblock", alias.address, "ct_1"]);
        const nobody = yield* run(["contacts", "block", alias.address, "nobody@example.com"]);
        expect(Arr.join(nobody.err, "\n")).toContain("That alias has no such contact.");

        expect((yield* run(["recipients", "list"])).text).toBe(
          "No forwarding addresses yet: add one in the web app.",
        );
      }),
    );

    it.effect("creates a temporary inbox, and waits for the code with --wait --otp", () =>
      Effect.gen(function* () {
        const { api, ada, run } = yield* loggedIn();
        const first = Str.trim((yield* run(["temp"])).text);
        expect(first).toMatch(/^[2-9a-z]{10}@tmp\.test$/);

        const waiting = yield* Effect.forkChild(
          run(["temp", "--wait", "--otp", "--timeout", "60"]),
        );
        // The second inbox shows up in Ada's list once the CLI created it (real HTTP meanwhile).
        const Inboxes = Schema.Array(Schema.Struct({ address: Schema.String }));
        const listInboxes = ada.browser
          .get("/v1/inboxes")
          .pipe(Effect.map((response) => Schema.decodeUnknownSync(Inboxes)(response.body)));
        const inboxes = yield* listInboxes.pipe(
          Effect.tap(() => TestClock.withLive(Effect.sleep("20 millis"))),
          Effect.repeat({ until: (found) => found.length === 2, times: 200 }),
        );
        const address = Option.getOrElse(
          Arr.findFirst(inboxes, (inbox) => inbox.address !== first),
          () => ({ address: "" }),
        ).address;
        // Mail arrives; the inbound Lambda's store stands in for SMTP.
        yield* Effect.gen(function* () {
          const [localPart = "", domain = ""] = address.split("@");
          const stored = yield* (yield* AliasRepo.make()).findByAddress(domain, localPart);
          yield* (yield* Inbox.Inbox).store(
            yield* Effect.fromOption(stored),
            new TextEncoder().encode(
              "From: login@service.example\r\nSubject: Your code\r\n\r\nYour verification code is 482913.\r\n",
            ),
          );
        }).pipe(Effect.provide(api.context));
        // The API's long poll sleeps on the test clock between its looks.
        yield* Effect.forEach(
          Arr.range(1, 10),
          () =>
            TestClock.withLive(Effect.sleep("30 millis")).pipe(
              Effect.andThen(TestClock.adjust("1 second")),
            ),
          { concurrency: 1, discard: true },
        );
        const result = yield* Fiber.join(waiting);
        expect(Exit.isSuccess(result.exit)).toBe(true);
        expect(result.text).toBe("482913");
        expect(Arr.join(result.err, "\n")).toContain(`Waiting for mail to ${address}`);
      }),
    );

    it.effect("takes ALIAS_TOKEN from the environment and names a missing scope", () =>
      Effect.gen(function* () {
        const { api, ada, run } = yield* setUp();
        const created = yield* ada.browser.post("/v1/tokens", {
          name: "ci",
          scopes: ["aliases:read"],
        });
        const { token } = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(
          created.body,
        );
        const env = { ALIAS_TOKEN: token, ALIAS_API_URL: api.url };
        expect((yield* run(["whoami"], env)).text).toBe(`username: ada\nuserId: ${ada.userId}`);
        const refused = yield* run(["recipients", "list"], env);
        expect(Exit.isFailure(refused.exit)).toBe(true);
        expect(Arr.join(refused.err, "\n")).toContain(
          "Your token lacks the recipients:read scope.",
        );
        const revoked = yield* run(["whoami"], {
          ...env,
          ALIAS_TOKEN: `alias_pat_${"x".repeat(43)}`,
        });
        expect(Arr.join(revoked.err, "\n")).toContain("Your login expired or was revoked.");
      }),
    );

    it.effect("tells a denied login apart", () =>
      Effect.gen(function* () {
        const { api, ada, configDir } = yield* setUp();
        const { login, output, code } = yield* startLogin(api.url, configDir);
        yield* ada.browser.post("/v1/device/deny", { userCode: code });
        yield* TestClock.adjust("5 seconds");
        const exit = yield* Fiber.join(login);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(Arr.join(output.err, "\n")).toContain("The login was denied.");
      }),
    );
  });
});
