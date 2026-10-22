import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { Address } from "../src/index.ts";

const shared = ["alias.test"];

describe("Address.parse", () => {
  it.effect("normalizes case and whitespace", () =>
    Effect.gen(function* () {
      const address = yield* Address.parse("  Hello@User1.Alias.TEST ");
      expect(address).toEqual({ local: "hello", domain: "user1.alias.test" });
    }),
  );

  it.effect("rejects addresses without a domain", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Address.parse("nobody@"));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe("Address.classify", () => {
  it.effect("detects shared random, user subdomain and custom domains", () =>
    Effect.gen(function* () {
      const random = Address.classify(yield* Address.parse("k7m2@alias.test"), shared);
      const sub = Address.classify(yield* Address.parse("shop@user1.alias.test"), shared);
      const custom = Address.classify(yield* Address.parse("me@example.org"), shared);
      expect(Address.Destination.$is("SharedRandom")(random)).toBe(true);
      expect(Address.Destination.$is("UserSubdomain")(sub) && sub.username).toBe("user1");
      expect(Address.Destination.$is("Custom")(custom)).toBe(true);
    }),
  );

  it.effect("treats nested subdomains as custom", () =>
    Effect.gen(function* () {
      const nested = Address.classify(yield* Address.parse("a@x.user1.alias.test"), shared);
      expect(Address.Destination.$is("Custom")(nested)).toBe(true);
    }),
  );
});

describe("Address.reverseToken", () => {
  it.effect("extracts the token from reverse aliases", () =>
    Effect.gen(function* () {
      const address = yield* Address.parse("shop+r.abc123@user1.alias.test");
      expect(Address.reverseToken(address)).toEqual(
        Option.some({ aliasLocal: "shop", token: "abc123" }),
      );
      expect(Option.isNone(Address.reverseToken(yield* Address.parse("shop@alias.test")))).toBe(
        true,
      );
    }),
  );
});

describe("Address length limits", () => {
  it.effect("lets reverse aliases run past 64 octets, but not plain local parts", () =>
    Effect.gen(function* () {
      const token = "a".repeat(120);
      const reverse = yield* Address.parse(`shop+r.${token}@user1.alias.test`);
      expect(Address.reverseToken(reverse)).toEqual(Option.some({ aliasLocal: "shop", token }));
      const plain = yield* Effect.exit(Address.parse(`${"a".repeat(65)}@alias.test`));
      expect(Exit.isFailure(plain)).toBe(true);
      const longAlias = yield* Effect.exit(Address.parse(`${"a".repeat(65)}+r.abc@alias.test`));
      expect(Exit.isFailure(longAlias)).toBe(true);
    }),
  );

  it.effect("rejects addresses longer than 254 characters", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Address.parse(`shop+r.${"a".repeat(240)}@alias.test`));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("formats reverse addresses on the alias's own domain", () =>
    Effect.gen(function* () {
      const alias = yield* Address.parse("shop@mydomain.example");
      expect(Address.format(Address.reverseAddress(alias, "abc"))).toBe(
        "shop+r.abc@mydomain.example",
      );
    }),
  );
});
