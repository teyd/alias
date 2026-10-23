import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { InviteCode } from "../src/index.ts";

describe("InviteCode", () => {
  it("draws 20 consonants from random bytes without bias, shown in groups of four", () => {
    const bytes = Uint8Array.from([255, 240, ...Arr.range(0, 19)]);
    const code = InviteCode.fromBytes(bytes);
    expect(code).toEqual(Option.some("BCDFGHJKLMNPQRSTVWXZ"));
    expect(Option.map(code, InviteCode.format)).toEqual(Option.some("BCDF-GHJK-LMNP-QRST-VWXZ"));
    // Too many bytes at or above 240 to fill a code: the caller draws again.
    expect(InviteCode.fromBytes(Uint8Array.from([...Arr.range(0, 18), 250]))).toEqual(
      Option.none(),
    );
  });

  it("normalizes what a person types or pastes: case, dashes and spaces don't matter", () => {
    expect(InviteCode.normalize("bcdf-ghjk-lmnp-qrst-vwxz")).toEqual(
      Option.some("BCDFGHJKLMNPQRSTVWXZ"),
    );
    expect(InviteCode.normalize(" BCDF GHJK LMNP QRST VWXZ\n")).toEqual(
      Option.some("BCDFGHJKLMNPQRSTVWXZ"),
    );
    expect(
      Arr.map(
        [
          "",
          "BCDF-GHJK",
          "BCDF-GHJK-LMNP-QRST-VWX",
          "BCDF-GHJK-LMNP-QRST-VWXZB",
          "ABCD-GHJK-LMNP-QRST-VWXZ",
          "BCDF-GHJK-LMNP-QRST-VWX1",
        ],
        InviteCode.normalize,
      ),
    ).toEqual(Arr.replicate(Option.none(), 6));
  });
});
