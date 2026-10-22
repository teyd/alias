import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { SharedDomains } from "../src/index.ts";

describe("SharedDomains.parse", () => {
  it.effect("lowercases, trims and dedupes, keeping the configured order", () =>
    Effect.gen(function* () {
      expect(yield* SharedDomains.parse(" Alias.example , alias2.example,alias.example,")).toEqual([
        "alias.example",
        "alias2.example",
      ]);
    }),
  );

  it.effect.each<readonly [string, string]>([
    ["", "no domain given"],
    [" , ", "no domain given"],
    ["alias.example,localhost", "not a domain: localhost"],
    ["alias.example,bad_label.example", "not a domain: bad_label.example"],
  ])("rejects %j", ([value, reason]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(SharedDomains.parse(value));
      expect(error.reason).toBe(reason);
    }),
  );
});

describe("SharedDomains.config", () => {
  const read = (env: Record<string, string>) =>
    SharedDomains.config.parse(ConfigProvider.fromEnv({ env }));

  it.effect("reads ALIAS_SHARED_DOMAINS", () =>
    Effect.gen(function* () {
      expect(yield* read({ ALIAS_SHARED_DOMAINS: "alias.test,Alias2.test" })).toEqual([
        "alias.test",
        "alias2.test",
      ]);
    }),
  );

  it.effect("fails with the reason when the value is not a domain list", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(read({ ALIAS_SHARED_DOMAINS: "nope" }));
      expect(String(error)).toContain("not a domain: nope");
    }),
  );
});
