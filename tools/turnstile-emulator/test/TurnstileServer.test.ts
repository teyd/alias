import { Turnstile } from "@alias/turnstile";
import badJson from "@alias/turnstile/fixtures/recorded-bad-json.json" with { type: "json" };
import badMethod from "@alias/turnstile/fixtures/recorded-bad-method.json" with { type: "json" };
import fail from "@alias/turnstile/fixtures/recorded-fail.json" with { type: "json" };
import invalidSecret from "@alias/turnstile/fixtures/recorded-invalid-secret.json" with { type: "json" };
import missingResponse from "@alias/turnstile/fixtures/recorded-missing-response.json" with { type: "json" };
import missingSecret from "@alias/turnstile/fixtures/recorded-missing-secret.json" with { type: "json" };
import passAnyToken from "@alias/turnstile/fixtures/recorded-pass-any-token.json" with { type: "json" };
import passJson from "@alias/turnstile/fixtures/recorded-pass-json.json" with { type: "json" };
import pass from "@alias/turnstile/fixtures/recorded-pass.json" with { type: "json" };
import spent from "@alias/turnstile/fixtures/recorded-spent.json" with { type: "json" };
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { TestKeys, TurnstileServer } from "../src/index.ts";

/** A recorded exchange: what was sent to Cloudflare and what it answered. */
interface Recorded {
  readonly request: {
    readonly form?: Readonly<Record<string, string>>;
    readonly json?: Readonly<Record<string, string>>;
    readonly "raw-json"?: string;
    readonly method?: string;
  };
  readonly status: number;
  readonly body: JsonObject;
}

type JsonObject = Readonly<Record<string, Schema.Json>>;
const decodeObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

const recordings: ReadonlyArray<readonly [string, Recorded]> = [
  ["pass", pass],
  ["pass (JSON)", passJson],
  ["pass (any token)", passAnyToken],
  ["fail", fail],
  ["spent", spent],
  ["missing response", missingResponse],
  ["missing secret", missingSecret],
  ["invalid secret", invalidSecret],
  ["malformed JSON", badJson],
  ["GET", badMethod],
];

/** Replays a recorded request against the emulator, as `curl` sent it to Cloudflare. */
const replay = (url: string, { request }: Recorded) =>
  Effect.promise(async () => {
    const init: RequestInit =
      request.method !== undefined
        ? { method: request.method }
        : request.form !== undefined
          ? { method: "POST", body: new URLSearchParams(request.form) }
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: request["raw-json"] ?? JSON.stringify(request.json),
            };
    const response = await fetch(`${url}/turnstile/v0/siteverify`, init);
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: decodeObject(await response.json()),
    };
  });

/** The timestamp is when the token was redeemed, so it differs between any two answers. */
const withoutTimestamp = (body: JsonObject) => R.remove(body, "challenge_ts");

describe("Turnstile emulator (contract: answers as Cloudflare recorded them)", () => {
  it.layer(TurnstileServer.layer())((it) => {
    it.effect.each(recordings)("%s", ([, recorded]) =>
      Effect.gen(function* () {
        const { url } = yield* TurnstileServer.TurnstileServer;
        const answered = yield* replay(url, recorded);
        expect(answered.status).toBe(recorded.status);
        expect(answered.contentType).toBe("application/json");
        expect(withoutTimestamp(answered.body)).toEqual(withoutTimestamp(recorded.body));
        const decoded = yield* Schema.decodeUnknownEffect(Turnstile.Response)(answered.body);
        // A success says when the widget was solved, as an ISO 8601 timestamp.
        const solvedAt = Option.flatMap(
          Option.fromUndefinedOr(decoded.challenge_ts),
          DateTime.make,
        );
        expect(Option.isSome(solvedAt)).toBe(decoded.success);
      }),
    );

    it.effect("serves the widget script", () =>
      Effect.gen(function* () {
        const { url } = yield* TurnstileServer.TurnstileServer;
        const response = yield* Effect.promise(() =>
          fetch(`${url}/turnstile/v0/api.js?render=explicit`),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/javascript");
        const script = yield* Effect.promise(() => response.text());
        expect(script).toContain(TestKeys.DUMMY_TOKEN);
        expect(script).toContain("window.turnstile");
      }),
    );
  });
});

/** The production client against the emulator, with each test secret. */
const client = (url: string, secret: string) =>
  Turnstile.layer({ url, siteKey: TestKeys.siteKeys.passes, secret: Redacted.make(secret) }).pipe(
    Layer.provide(NodeCrypto.layer),
  );

const verify = (secret: string, token: string) =>
  Effect.gen(function* () {
    const { url } = yield* TurnstileServer.TurnstileServer;
    const turnstile = yield* Effect.provide(
      Effect.service(Turnstile.Turnstile),
      client(url, secret),
    );
    return yield* Effect.result(turnstile.verify(token));
  });

describe("Turnstile client on the emulator", () => {
  it.layer(TurnstileServer.layer())((it) => {
    it.effect("the passing secret accepts the dummy token", () =>
      Effect.gen(function* () {
        const result = yield* verify(TestKeys.secrets.passes, TestKeys.DUMMY_TOKEN);
        expect(result).toMatchObject({ _tag: "Success", success: { _tag: "Human" } });
      }),
    );

    it.effect("the failing and spent secrets refuse it as a visitor's error", () =>
      Effect.gen(function* () {
        expect(yield* verify(TestKeys.secrets.fails, TestKeys.DUMMY_TOKEN)).toMatchObject({
          _tag: "Success",
          success: { _tag: "NotHuman", errorCodes: ["invalid-input-response"] },
        });
        expect(yield* verify(TestKeys.secrets.spent, TestKeys.DUMMY_TOKEN)).toMatchObject({
          _tag: "Success",
          success: { _tag: "NotHuman", errorCodes: ["timeout-or-duplicate"] },
        });
      }),
    );

    it.effect("an empty or overlong token is refused without asking", () =>
      Effect.gen(function* () {
        expect(yield* verify("not-a-secret", "")).toMatchObject({
          success: { _tag: "NotHuman" },
        });
        expect(yield* verify("not-a-secret", "a".repeat(2049))).toMatchObject({
          success: { _tag: "NotHuman" },
        });
      }),
    );

    it.effect("a wrong secret makes Turnstile unavailable, not the visitor a bot", () =>
      Effect.gen(function* () {
        expect(
          yield* verify("0x4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", TestKeys.DUMMY_TOKEN),
        ).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "TurnstileUnavailable" },
        });
      }),
    );
  });

  // Live clock: the retries really wait.
  it.live("an unreachable Siteverify is unavailable after the retries", () =>
    Effect.gen(function* () {
      const turnstile = yield* Effect.provide(
        Effect.service(Turnstile.Turnstile),
        // Port 9 (discard) on loopback: nothing listens, the connection is refused at once.
        client("http://127.0.0.1:9", TestKeys.secrets.passes),
      );
      const result = yield* Effect.result(turnstile.verify(TestKeys.DUMMY_TOKEN));
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnstileUnavailable" } });
    }),
  );
});
