import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/**
 * Cloudflare Turnstile, the human check at sign-up (PLAN.md §20.27). The browser solves a widget
 * and gets a single-use token valid for 300 seconds; the server redeems it at the Siteverify API.
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

/** Where Cloudflare serves the widget script and the Siteverify API, the production default. */
export const CLOUDFLARE = "https://challenges.cloudflare.com";

/** The documented maximum token length; anything longer is refused without asking Cloudflare. */
const MAX_TOKEN_LENGTH = 2048;

// The field names are the API's own, not ours to choose.
/* oxlint-disable effect/require-is-prefix-for-boolean-schema-field */
/**
 * A Siteverify answer, as documented and as recorded (`fixtures/`). Every answer has `success`
 * and `error-codes`, failures included (HTTP 400 for a missing or invalid secret and malformed
 * requests); `messages` and `metadata` appear only in real answers.
 */
export const Response = Schema.Struct({
  success: Schema.Boolean,
  "error-codes": Schema.Array(Schema.String),
  challenge_ts: Schema.optionalKey(Schema.String),
  hostname: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  cdata: Schema.optionalKey(Schema.String),
  messages: Schema.optionalKey(Schema.Array(Schema.String)),
  metadata: Schema.optionalKey(
    Schema.Struct({
      ephemeral_id: Schema.optionalKey(Schema.String),
      result_with_testing_key: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
/* oxlint-enable effect/require-is-prefix-for-boolean-schema-field */
export type Response = typeof Response.Type;

/**
 * The visitor's fault: no token, a forged, malformed or expired one, or one already redeemed. The
 * widget must be solved again. Every other error code is ours or Cloudflare's.
 */
const VISITOR_ERRORS = ["missing-input-response", "invalid-input-response", "timeout-or-duplicate"];

/** What a token proved. */
export const Verdict = Schema.TaggedUnion({
  Human: {},
  NotHuman: { errorCodes: Schema.Array(Schema.String) },
});
export type Verdict = typeof Verdict.Type;

const human = Verdict.cases.Human.make({});
const notHuman = (errorCodes: ReadonlyArray<string>) => Verdict.cases.NotHuman.make({ errorCodes });

/**
 * Siteverify couldn't answer for the token: network, timeout, a 5xx, `internal-error`, or our own
 * misconfiguration (`invalid-input-secret`, `bad-request`). Callers fail closed.
 */
export class TurnstileUnavailable extends Schema.TaggedError<TurnstileUnavailable>()(
  "TurnstileUnavailable",
  { reason: Schema.String },
) {}

/** What a Siteverify answer means for the token, or why it means nothing. */
export const judge = (response: Response): Verdict | TurnstileUnavailable => {
  if (response.success) return human;
  const codes = response["error-codes"];
  return Arr.isReadonlyArrayNonEmpty(codes) &&
    Arr.every(codes, (code) => Arr.contains(VISITOR_ERRORS, code))
    ? notHuman(codes)
    : new TurnstileUnavailable({
        reason: `siteverify: ${Arr.join(codes, ", ") || "no error code"}`,
      });
};

export class Turnstile extends Context.Service<
  Turnstile,
  {
    /** The public site key the widget renders with. */
    readonly siteKey: string;
    /** The widget script, for explicit rendering (`turnstile.render`). */
    readonly scriptUrl: string;
    /** Redeems a widget token. */
    readonly verify: (token: string) => Effect.Effect<Verdict, TurnstileUnavailable>;
  }
>()("@alias/turnstile/Turnstile") {}

export interface Settings {
  /** {@link CLOUDFLARE} in production, `tools/turnstile-emulator` in tests and dev. */
  readonly url: string;
  readonly siteKey: string;
  readonly secret: Redacted.Redacted<string>;
}

/** Each attempt waits at most this long; Cloudflare answers in well under a second. */
const ATTEMPT_TIMEOUT = "5 seconds";

/** Why one attempt failed in a way worth retrying with the same idempotency key. */
class Retryable extends Schema.TaggedError<Retryable>()("Retryable", { reason: Schema.String }) {}

const decodeResponse = HttpClientResponse.schemaBodyJson(Response);

const make = Effect.fn("Turnstile.make")(function* (settings: Settings) {
  const client = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const endpoint = `${settings.url}/turnstile/v0/siteverify`;

  /** One POST. A 5xx, a timeout, a network failure or `internal-error` is worth another try. */
  const attempt = Effect.fn("Turnstile.attempt")(function* (token: string, idempotencyKey: string) {
    const request = HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyUrlParams({
        secret: Redacted.value(settings.secret),
        response: token,
        idempotency_key: idempotencyKey,
      }),
    );
    const answered = yield* HttpClient.withScope(client)
      .execute(request)
      .pipe(
        Effect.flatMap((response) =>
          response.status >= 500
            ? Effect.succeed(Option.none<Response>())
            : Effect.map(decodeResponse(response), Option.some),
        ),
        Effect.scoped,
        Effect.timeout(ATTEMPT_TIMEOUT),
        Effect.result,
      );
    if (Result.isFailure(answered)) {
      const failure = answered.failure;
      return yield* P.isTagged(failure, "SchemaError")
        ? new TurnstileUnavailable({ reason: "unexpected answer" })
        : new Retryable({ reason: failure._tag });
    }
    if (Option.isNone(answered.success)) return yield* new Retryable({ reason: "5xx" });
    const response = answered.success.value;
    const verdict = judge(response);
    if (!(verdict instanceof TurnstileUnavailable)) return verdict;
    return yield* Arr.contains(response["error-codes"], "internal-error")
      ? new Retryable({ reason: verdict.reason })
      : verdict;
  });

  const verify = Effect.fn("Turnstile.verify")(function* (token: string) {
    if (Str.isEmpty(token) || token.length > MAX_TOKEN_LENGTH) {
      return notHuman(["invalid-input-response"]);
    }
    // The same key on every retry: Cloudflare then answers a retry as it answered the first try,
    // instead of calling the redeemed token a duplicate.
    const idempotencyKey = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError((error) => new TurnstileUnavailable({ reason: error.message })));
    return yield* attempt(token, idempotencyKey).pipe(
      Effect.retry({
        while: (error) => P.isTagged(error, "Retryable"),
        schedule: Schedule.exponential("200 millis"),
        times: 2,
      }),
      Effect.catchTag("Retryable", (error) =>
        Effect.fail(new TurnstileUnavailable({ reason: error.reason })),
      ),
    );
  });

  return Turnstile.of({
    siteKey: settings.siteKey,
    scriptUrl: `${settings.url}/turnstile/v0/api.js?render=explicit`,
    verify,
  });
});

/** Turnstile at `settings.url`. Callers provide `Crypto` (idempotency keys). */
export const layer = (settings: Settings): Layer.Layer<Turnstile, never, Crypto.Crypto> =>
  Layer.effect(Turnstile, make(settings)).pipe(Layer.provide(FetchHttpClient.layer));
