import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import docsFailure from "../fixtures/docs-failure.json" with { type: "json" };
import docsSuccess from "../fixtures/docs-success.json" with { type: "json" };
import docsTestingDuplicate from "../fixtures/docs-testing-duplicate.json" with { type: "json" };
import docsTestingSuccess from "../fixtures/docs-testing-success.json" with { type: "json" };
import badJson from "../fixtures/recorded-bad-json.json" with { type: "json" };
import badMethod from "../fixtures/recorded-bad-method.json" with { type: "json" };
import fail from "../fixtures/recorded-fail.json" with { type: "json" };
import invalidSecret from "../fixtures/recorded-invalid-secret.json" with { type: "json" };
import missingResponse from "../fixtures/recorded-missing-response.json" with { type: "json" };
import missingSecret from "../fixtures/recorded-missing-secret.json" with { type: "json" };
import passAnyToken from "../fixtures/recorded-pass-any-token.json" with { type: "json" };
import passJson from "../fixtures/recorded-pass-json.json" with { type: "json" };
import pass from "../fixtures/recorded-pass.json" with { type: "json" };
import spent from "../fixtures/recorded-spent.json" with { type: "json" };
import { Turnstile } from "../src/index.ts";

const decode = Schema.decodeUnknownEffect(Turnstile.Response);

/** What `judge` makes of an answer, by tag. */
const verdictOf = (body: Schema.Json) =>
  Effect.map(decode(body), (response) => Turnstile.judge(response)._tag);

describe("Turnstile.Response (contract: documented and recorded Siteverify answers)", () => {
  it.effect("decodes every documented and recorded answer, errors included", () =>
    Effect.forEach(
      [
        docsSuccess,
        docsFailure,
        docsTestingSuccess,
        docsTestingDuplicate,
        ...[pass, passJson, passAnyToken, fail, spent, missingResponse].map((r) => r.body),
        ...[missingSecret, invalidSecret, badJson, badMethod].map((r) => r.body),
      ],
      (body) => decode(body),
      { concurrency: 1, discard: true },
    ),
  );

  it.effect(
    "a success is a human; a visitor's bad token is not; everything else is unavailable",
    () =>
      Effect.gen(function* () {
        expect(yield* verdictOf(docsSuccess)).toBe("Human");
        expect(yield* verdictOf(docsTestingSuccess)).toBe("Human");
        expect(yield* verdictOf(pass.body)).toBe("Human");
        expect(yield* verdictOf(docsFailure)).toBe("NotHuman");
        expect(yield* verdictOf(fail.body)).toBe("NotHuman");
        expect(yield* verdictOf(spent.body)).toBe("NotHuman");
        expect(yield* verdictOf(docsTestingDuplicate)).toBe("NotHuman");
        expect(yield* verdictOf(missingResponse.body)).toBe("NotHuman");
        // Our secret or request is wrong: the visitor can't fix that by solving the widget again.
        expect(yield* verdictOf(missingSecret.body)).toBe("TurnstileUnavailable");
        expect(yield* verdictOf(invalidSecret.body)).toBe("TurnstileUnavailable");
        expect(yield* verdictOf(badJson.body)).toBe("TurnstileUnavailable");
        expect(yield* verdictOf(badMethod.body)).toBe("TurnstileUnavailable");
        expect(Turnstile.judge({ success: false, "error-codes": ["internal-error"] })._tag).toBe(
          "TurnstileUnavailable",
        );
        expect(Turnstile.judge({ success: false, "error-codes": [] })._tag).toBe(
          "TurnstileUnavailable",
        );
      }),
  );
});
