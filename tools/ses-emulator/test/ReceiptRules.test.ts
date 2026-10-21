import { describe, expect, it } from "@effect/vitest";
import { conditionMatches, ruleMatches, type ReceiptRule } from "../src/index.ts";

const rule = (recipients: ReadonlyArray<string>): ReceiptRule => ({
  name: "r",
  enabled: true,
  recipients,
  s3: { bucket: "spool", objectKeyPrefix: "in/" },
  scanEnabled: true,
});

describe("conditionMatches (SES recipient semantics)", () => {
  it("matches an address and its +label variants", () => {
    expect(conditionMatches("user@example.com", "user@example.com")).toBe(true);
    expect(conditionMatches("user@example.com", "user+shop@example.com")).toBe(true);
    expect(conditionMatches("user+a@example.com", "user+b@example.com")).toBe(false);
  });

  it("matches a domain but not its subdomains", () => {
    expect(conditionMatches("example.com", "x@example.com")).toBe(true);
    expect(conditionMatches("example.com", "x@sub.example.com")).toBe(false);
  });

  it("matches every subdomain with a leading dot, but not the parent", () => {
    expect(conditionMatches(".example.com", "x@user1.example.com")).toBe(true);
    expect(conditionMatches(".example.com", "x@example.com")).toBe(false);
  });
});

describe("ruleMatches", () => {
  const verified = ["alias.test", "custom.test"];

  it("matches all verified domains when the rule has no recipients", () => {
    expect(ruleMatches(rule([]), "a@custom.test", verified)).toBe(true);
    expect(ruleMatches(rule([]), "a@user1.alias.test", verified)).toBe(true);
    expect(ruleMatches(rule([]), "a@unverified.test", verified)).toBe(false);
  });

  it("covers apex and wildcard subdomains with two conditions", () => {
    const shared = rule(["alias.test", ".alias.test"]);
    expect(ruleMatches(shared, "k7m2@alias.test", verified)).toBe(true);
    expect(ruleMatches(shared, "shop@user1.alias.test", verified)).toBe(true);
    expect(ruleMatches(shared, "me@custom.test", verified)).toBe(false);
  });

  it("ignores disabled rules", () => {
    expect(ruleMatches({ ...rule([]), enabled: false }, "a@alias.test", verified)).toBe(false);
  });
});
