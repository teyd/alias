import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { Username } from "../src/index.ts";

const reason = (input: string) =>
  Username.parse(input).pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("Username.parse", () => {
  it.effect("normalizes case and surrounding whitespace", () =>
    Effect.gen(function* () {
      expect(yield* Username.parse("  Ada-Lovelace42 ")).toBe("ada-lovelace42");
    }),
  );

  it.effect("accepts DNS-label-safe names at both length limits", () =>
    Effect.gen(function* () {
      expect(yield* Username.parse("ada")).toBe("ada");
      expect(yield* Username.parse("a".repeat(30))).toBe("a".repeat(30));
    }),
  );

  it.effect("rejects names that would not be a safe DNS label", () =>
    Effect.gen(function* () {
      expect(yield* reason("ab")).toBe("too-short");
      expect(yield* reason("a".repeat(31))).toBe("too-long");
      expect(yield* reason("ada.lovelace")).toBe("invalid-characters");
      expect(yield* reason("ada_lovelace")).toBe("invalid-characters");
      expect(yield* reason("ada lovelace")).toBe("invalid-characters");
      expect(yield* reason("42ada")).toBe("must-start-with-letter");
      expect(yield* reason("-ada")).toBe("must-start-with-letter");
      expect(yield* reason("ada-")).toBe("hyphen-placement");
      expect(yield* reason("ada--lovelace")).toBe("hyphen-placement");
      expect(yield* reason("xn--80ak6aa92e")).toBe("hyphen-placement");
    }),
  );

  it.effect("rejects non-ASCII lookalikes instead of folding them", () =>
    Effect.gen(function* () {
      // Cyrillic a (U+0430), fullwidth a (U+FF41), and a combining acute accent.
      expect(yield* reason("\u0430dmin-team")).toBe("invalid-characters");
      expect(yield* reason("\uff41da")).toBe("invalid-characters");
      expect(yield* reason("ade\u0301le")).toBe("invalid-characters");
    }),
  );

  it.effect("reserves infrastructure, role and brand names, and their lookalikes", () =>
    Effect.gen(function* () {
      const names = ["www", "mail", "admin", "api", "postmaster", "paypal", "alias"];
      const lookalikes = ["adm1n", "paypa1", "rnail", "g00gle", "no-reply", "pay-pal"];
      const reasons = yield* Effect.forEach([...names, ...lookalikes], reason, {
        concurrency: "unbounded",
      });
      expect(Arr.dedupe(reasons)).toEqual(["reserved"]);
    }),
  );
});

describe("Username.skeleton", () => {
  it("folds ASCII lookalikes so they clash", () => {
    expect(Username.skeleton("j0hn")).toBe(Username.skeleton("john"));
    expect(Username.skeleton("bi11")).toBe(Username.skeleton("bill"));
    expect(Username.skeleton("modern")).toBe(Username.skeleton("modem"));
    expect(Username.skeleton("vvalter")).toBe(Username.skeleton("walter"));
    expect(Username.skeleton("ada-lovelace")).toBe(Username.skeleton("adalovelace"));
  });

  it("keeps distinct names distinct", () => {
    expect(Username.skeleton("alice")).not.toBe(Username.skeleton("alex"));
    expect(Username.skeleton("john")).not.toBe(Username.skeleton("joan"));
  });
});
