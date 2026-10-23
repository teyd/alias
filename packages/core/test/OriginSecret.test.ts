import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Keyring, OriginSecret } from "../src/index.ts";

const secret = (fill: number) => Buffer.alloc(32, fill).toString("base64url");

describe("OriginSecret", () => {
  it.effect("CloudFront sends the current key, and the API accepts it and retired ones", () =>
    Effect.gen(function* () {
      const keys = yield* Keyring.parse(Redacted.make(`2:${secret(2)},1:${secret(1)}`));
      const sent = Redacted.value(OriginSecret.headerValue(keys));
      expect(sent).toBe(`2:${secret(2)}`);
      expect(OriginSecret.verify(keys, sent)).toBe(true);
      expect(OriginSecret.verify(keys, `1:${secret(1)}`)).toBe(true);
    }),
  );

  it.effect("refuses anything else", () =>
    Effect.gen(function* () {
      const keys = yield* Keyring.parse(Redacted.make(`2:${secret(2)},1:${secret(1)}`));
      expect(
        [
          "",
          secret(2),
          `3:${secret(2)}`,
          `1:${secret(2)}`,
          `2:${secret(3)}`,
          `2:${secret(2)}x`,
          `2:${secret(2).slice(0, -2)}`,
          ` 2:${secret(2)}`,
          `2:${secret(2)},1:${secret(1)}`,
        ].map((presented) => OriginSecret.verify(keys, presented)),
      ).toEqual(Array(9).fill(false));
    }),
  );
});
