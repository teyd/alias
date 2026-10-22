import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Keyring } from "../src/index.ts";

const secret = (fill: number) => Buffer.alloc(32, fill).toString("base64url");

describe("Keyring.parse", () => {
  it.effect("signs with the first key and keeps the others for verifying", () =>
    Effect.gen(function* () {
      const keys = yield* Keyring.parse(Redacted.make(` 2:${secret(2)}, 1:${secret(1)} `));
      expect(keys.current.version).toBe(2);
      expect(keys.retired.map((key) => key.version)).toEqual([1]);
      expect(Redacted.value(keys.current.secret)).toEqual(new Uint8Array(32).fill(2));
    }),
  );

  it.effect.each<readonly [string, string]>([
    ["", "no key given"],
    [`one:${secret(1)}`, "entry 1: expected <version>:<base64url secret>"],
    [`1:${secret(1)},2:not+base64`, "entry 2: expected <version>:<base64url secret>"],
    ["1:c2hvcnQ", "secrets need at least 32 bytes"],
    [`1:${secret(1)},1:${secret(2)}`, "key versions must be distinct"],
    [`256:${secret(1)}`, "key versions must be integers from 0 to 255"],
  ])("rejects %j without echoing a secret", ([value, reason]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Keyring.parse(Redacted.make(value)));
      expect(error.reason).toBe(reason);
    }),
  );

  it.effect("finds current and retired keys by version", () =>
    Effect.gen(function* () {
      const keys = yield* Keyring.parse(Redacted.make(`2:${secret(2)},1:${secret(1)}`));
      expect(Keyring.find(keys, 1).pipe((found) => found._tag)).toBe("Some");
      expect(Keyring.find(keys, 3).pipe((found) => found._tag)).toBe("None");
    }),
  );
});
