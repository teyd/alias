import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { secrets } from "./TestKeys.ts";

/**
 * The Siteverify API for the test secrets, as Cloudflare answered them when recorded
 * (`packages/turnstile/fixtures/recorded-*.json`). Where the recordings and the docs disagree, the
 * recordings win: a test secret judges any token, not only the dummy one, and success answers
 * carry no `action`.
 */

// The field names are the API's own.
/* oxlint-disable effect/require-is-prefix-for-boolean-schema-field */
/** A Siteverify answer's body, the fields the test secrets produce. */
interface Body {
  readonly success: boolean;
  readonly "error-codes": ReadonlyArray<string>;
  readonly challenge_ts?: string;
  readonly hostname?: string;
  readonly messages?: ReadonlyArray<string>;
  readonly metadata?: { readonly result_with_testing_key: boolean };
}
/* oxlint-enable effect/require-is-prefix-for-boolean-schema-field */

/** A Siteverify answer: HTTP status and JSON body. */
export interface Answer {
  readonly status: number;
  readonly body: Body;
}

/** The recorded host every test-key success names, whatever page the widget ran on. */
const TEST_HOSTNAME = "example.com";
const testing = { result_with_testing_key: true };

const failure = (
  status: number,
  code: string,
  extra: Pick<Body, "messages" | "metadata"> = {},
): Answer => ({
  status,
  body: { "error-codes": [code], success: false, messages: [], ...extra },
});

/** What a request carried, from a form or a JSON body; empty strings count as missing. */
interface Fields {
  readonly secret: Option.Option<string>;
  readonly response: Option.Option<string>;
}

const JsonFields = Schema.fromJsonString(
  Schema.Struct({
    secret: Schema.optionalKey(Schema.Unknown),
    response: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeJsonFields = Schema.decodeUnknownResult(JsonFields);

const present = (value: Option.Option<string>) => Option.filter(value, Str.isNonEmpty);

const parseFields = (contentType: string, body: string): Result.Result<Fields, Answer> => {
  if (contentType.includes("application/json")) {
    return Result.match(decodeJsonFields(body), {
      onFailure: () =>
        Result.fail(
          failure(400, "bad-request", {
            messages: ["The request body could not be parsed as JSON."],
          }),
        ),
      onSuccess: (fields) =>
        Result.succeed({
          secret: present(Option.liftPredicate(fields.secret, P.isString)),
          response: present(Option.liftPredicate(fields.response, P.isString)),
        }),
    });
  }
  const form = new URLSearchParams(body);
  return Result.succeed({
    secret: present(Option.fromNullOr(form.get("secret"))),
    response: present(Option.fromNullOr(form.get("response"))),
  });
};

/** Answers one request to `/turnstile/v0/siteverify`. */
export const answer = (request: {
  readonly method: string;
  readonly contentType: string;
  readonly body: string;
  readonly now: DateTime.Utc;
}): Answer => {
  if (request.method !== "POST") {
    return failure(405, "bad-request", { messages: ["This API expects POST requests."] });
  }
  const parsed = parseFields(request.contentType, request.body);
  if (Result.isFailure(parsed)) return parsed.failure;
  const { secret, response } = parsed.success;
  if (Option.isNone(secret)) return failure(400, "missing-input-secret");
  const known: ReadonlyArray<string> = [secrets.passes, secrets.fails, secrets.spent];
  if (!Arr.contains(known, secret.value)) return failure(400, "invalid-input-secret");
  if (Option.isNone(response)) return failure(200, "missing-input-response");
  if (secret.value === secrets.fails) {
    return failure(200, "invalid-input-response", { metadata: testing });
  }
  if (secret.value === secrets.spent) {
    return failure(200, "timeout-or-duplicate", { metadata: testing });
  }
  return {
    status: 200,
    body: {
      challenge_ts: DateTime.formatIso(request.now),
      "error-codes": [],
      hostname: TEST_HOSTNAME,
      metadata: testing,
      success: true,
    },
  };
};
