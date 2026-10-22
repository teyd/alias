import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import response from "../fixtures/ssm-get-parameter-response.json" with { type: "json" };
import { Parameters } from "../src/index.ts";

const decode = Schema.decodeUnknownEffect(Parameters.GetParameterResult);

describe("Parameters (contract: AWS documentation payloads)", () => {
  it.effect("decodes the documented GetParameter response to its value and version", () =>
    Effect.gen(function* () {
      const { Parameter } = yield* decode(response);
      expect(Parameter.Type).toBe("SecureString");
      expect(Parameter.Version).toBe(3);
      expect(Parameter.Value).toBe(response.Parameter.Value);
    }),
  );

  it.effect("accepts the value redacted, as @distilled.cloud/aws hands it over", () =>
    Effect.gen(function* () {
      const { Parameter } = yield* decode({
        Parameter: { ...response.Parameter, Value: Redacted.make("secret") },
      });
      expect(Redacted.isRedacted(Parameter.Value)).toBe(true);
    }),
  );

  it.effect("rejects a parameter that isn't a SecureString", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decode({ Parameter: { ...response.Parameter, Type: "String" } }),
      );
      expect(error._tag).toBe("SchemaError");
    }),
  );
});
