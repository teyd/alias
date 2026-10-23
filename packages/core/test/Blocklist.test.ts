import { describe, expect, it } from "@effect/vitest";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { Blocklist } from "../src/index.ts";

const normalized = (entry: Blocklist.NewEntry) =>
  Result.match(Blocklist.normalize(entry), {
    onFailure: (reason) => reason,
    onSuccess: (id) => id,
  });

describe("Blocklist.normalize", () => {
  it("lowercases and trims addresses and domains", () => {
    expect(normalized({ kind: "address", value: "  News@Shop.Example " })).toBe(
      "news@shop.example",
    );
    expect(normalized({ kind: "domain", value: "Shop.Example" })).toBe("shop.example");
  });

  it("writes a domain with its subdomains as `*.domain`, asked either way", () => {
    expect(normalized({ kind: "domain", value: "shop.example", isSubdomainIncluded: true })).toBe(
      "*.shop.example",
    );
    expect(normalized({ kind: "domain", value: "*.shop.example" })).toBe("*.shop.example");
  });

  it("refuses what isn't an address or a domain", () => {
    expect(normalized({ kind: "address", value: "shop.example" })).toBe("invalid-address");
    expect(normalized({ kind: "address", value: "a b@shop.example" })).toBe("invalid-address");
    expect(normalized({ kind: "address", value: "a@localhost" })).toBe("invalid-address");
    expect(normalized({ kind: "address", value: `${"a".repeat(250)}@x.example` })).toBe(
      "invalid-address",
    );
    expect(normalized({ kind: "domain", value: "example" })).toBe("invalid-domain");
    expect(normalized({ kind: "domain", value: "news@shop.example" })).toBe("invalid-domain");
    expect(normalized({ kind: "domain", value: "*." })).toBe("invalid-domain");
  });
});

describe("Blocklist.entry", () => {
  it("reads each stored form back", () => {
    expect(Blocklist.entry("news@shop.example")).toEqual({
      id: "news@shop.example",
      kind: "address",
      value: "news@shop.example",
      isSubdomainIncluded: false,
    });
    expect(Blocklist.entry("shop.example")).toEqual({
      id: "shop.example",
      kind: "domain",
      value: "shop.example",
      isSubdomainIncluded: false,
    });
    expect(Blocklist.entry("*.shop.example")).toEqual({
      id: "*.shop.example",
      kind: "domain",
      value: "shop.example",
      isSubdomainIncluded: true,
    });
  });
});

describe("Blocklist.match", () => {
  const entries = HashSet.make("spam@mail.example", "tracker.example", "*.ads.example");

  it("blocks an address in any letter case", () => {
    expect(Blocklist.match(entries, "SPAM@Mail.Example")).toEqual(Option.some("spam@mail.example"));
    expect(Blocklist.match(entries, "friend@mail.example")).toEqual(Option.none());
  });

  it("blocks a domain exactly, without its subdomains", () => {
    expect(Blocklist.match(entries, "x@tracker.example")).toEqual(Option.some("tracker.example"));
    expect(Blocklist.match(entries, "x@eu.tracker.example")).toEqual(Option.none());
    expect(Blocklist.match(entries, "x@nottracker.example")).toEqual(Option.none());
  });

  it("blocks a domain with subdomains at any depth, but not a lookalike", () => {
    expect(Blocklist.match(entries, "x@ads.example")).toEqual(Option.some("*.ads.example"));
    expect(Blocklist.match(entries, "x@a.b.ads.example")).toEqual(Option.some("*.ads.example"));
    expect(Blocklist.match(entries, "x@badads.example")).toEqual(Option.none());
  });

  it("names the most specific entry", () => {
    const both = HashSet.make("x@ads.example", "*.ads.example");
    expect(Blocklist.match(both, "x@ads.example")).toEqual(Option.some("x@ads.example"));
  });

  it("finds nothing for an empty list or a sender without a domain", () => {
    expect(Blocklist.match(HashSet.empty(), "x@ads.example")).toEqual(Option.none());
    expect(Blocklist.match(entries, "ads.example")).toEqual(Option.none());
  });
});
