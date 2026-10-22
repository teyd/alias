import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { TempDomains } from "../src/index.ts";

const shared = ["alias.example"];

describe("TempDomains.parse", () => {
  it.effect("lowercases and dedupes; empty turns temp mail off", () =>
    Effect.gen(function* () {
      expect(yield* TempDomains.parse(" Tmp.example, tmp2.example,tmp.example", shared)).toEqual([
        "tmp.example",
        "tmp2.example",
      ]);
      expect(yield* TempDomains.parse("", shared)).toEqual([]);
    }),
  );

  it.effect.each<readonly [string, string]>([
    ["alias.example", "overlaps a shared domain: alias.example"],
    ["tmp.alias.example", "overlaps a shared domain: tmp.alias.example"],
    ["example", "not a domain: example"],
  ])("refuses %j", ([value, reason]) =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(TempDomains.parse(value, shared))).reason).toBe(reason);
    }),
  );

  it.effect("refuses a parent of a shared domain", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(TempDomains.parse("example.org", ["alias.example.org"]));
      expect(error.reason).toBe("overlaps a shared domain: example.org");
    }),
  );
});

describe("TempDomains.config", () => {
  const read = (env: Record<string, string>) =>
    TempDomains.config.parse(ConfigProvider.fromEnv({ env }));

  it.effect("reads ALIAS_TEMP_DOMAINS against ALIAS_SHARED_DOMAINS, off when unset", () =>
    Effect.gen(function* () {
      expect(
        yield* read({ ALIAS_SHARED_DOMAINS: "alias.test", ALIAS_TEMP_DOMAINS: "tmp.test" }),
      ).toEqual(["tmp.test"]);
      expect(yield* read({ ALIAS_SHARED_DOMAINS: "alias.test" })).toEqual([]);
      const error = yield* Effect.flip(
        read({ ALIAS_SHARED_DOMAINS: "alias.test", ALIAS_TEMP_DOMAINS: "x.alias.test" }),
      );
      expect(String(error)).toContain("overlaps a shared domain");
    }),
  );
});
