import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { UserCode } from "../src/index.ts";

describe("UserCode", () => {
  it("maps random bytes onto the 20 consonants without bias", () => {
    // 0..19 map in order; 240 and above are skipped rather than wrapped.
    const bytes = Uint8Array.from([240, 255, 0, 1, 2, 3, 19, 20, 239, 241, 59]);
    expect(UserCode.fromBytes(bytes)).toEqual(Option.some("BCDFZBZZ"));
    expect(UserCode.fromBytes(Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]))).toEqual(
      Option.none(),
    );
  });

  it("uses only consonants, in groups of four", () => {
    expect(UserCode.ALPHABET).toHaveLength(20);
    expect(UserCode.ALPHABET).not.toMatch(/[AEIOUY0-9]/);
    expect(UserCode.format("BCDFGHJK")).toBe("BCDF-GHJK");
  });

  it("normalizes what a person types: case, dashes and spaces don't matter", () => {
    expect(UserCode.normalize("bcdf-ghjk")).toEqual(Option.some("BCDFGHJK"));
    expect(UserCode.normalize(" BCDF GHJK ")).toEqual(Option.some("BCDFGHJK"));
    expect(
      Arr.map(["BCDF-GHJ", "BCDF-GHJKL", "ABCD-EFGH", "BCDF-GHJ1", ""], UserCode.normalize),
    ).toEqual(Arr.replicate(Option.none(), 5));
  });
});
