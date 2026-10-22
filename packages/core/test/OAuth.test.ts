import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { OAuth } from "../src/index.ts";

/** RFC 7636 Appendix B: the specification's own S256 example. */
const rfc7636 = {
  verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
};

describe("OAuth", () => {
  it.effect("verifies the RFC 7636 example and nothing else", () =>
    Effect.gen(function* () {
      expect(yield* OAuth.verifyS256(rfc7636.verifier, rfc7636.challenge)).toBe(true);
      expect(OAuth.isS256Challenge(rfc7636.challenge)).toBe(true);
      expect(yield* OAuth.verifyS256(`${rfc7636.verifier.slice(0, -1)}l`, rfc7636.challenge)).toBe(
        false,
      );
      // `plain` would compare the verifier itself; S256 never does.
      expect(yield* OAuth.verifyS256(rfc7636.challenge, rfc7636.challenge)).toBe(false);
      // Too short, too long, or outside the unreserved characters.
      expect(yield* OAuth.verifyS256("a".repeat(42), rfc7636.challenge)).toBe(false);
      expect(yield* OAuth.verifyS256("a".repeat(129), rfc7636.challenge)).toBe(false);
      expect(yield* OAuth.verifyS256(`${"a".repeat(43)}+`, rfc7636.challenge)).toBe(false);
      expect(OAuth.isS256Challenge(`${rfc7636.challenge}=`)).toBe(false);
      expect(OAuth.isS256Challenge("plain-challenge")).toBe(false);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it("allows https and loopback http redirect URIs only", () => {
    expect(OAuth.isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(OAuth.isAllowedRedirectUri("http://localhost:33418/callback")).toBe(true);
    expect(OAuth.isAllowedRedirectUri("http://127.0.0.1/callback?x=1")).toBe(true);
    expect(OAuth.isAllowedRedirectUri("http://[::1]:8080/cb")).toBe(true);
    expect(OAuth.isAllowedRedirectUri("http://example.com/callback")).toBe(false);
    expect(OAuth.isAllowedRedirectUri("http://localhost.evil.example/callback")).toBe(false);
    expect(OAuth.isAllowedRedirectUri("https://claude.ai/callback#frag")).toBe(false);
    expect(OAuth.isAllowedRedirectUri("https://user:pass@claude.ai/callback")).toBe(false);
    expect(OAuth.isAllowedRedirectUri("com.example.app:/callback")).toBe(false);
    expect(OAuth.isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(OAuth.isAllowedRedirectUri("/relative")).toBe(false);
    expect(OAuth.isLocalRedirectUri("http://127.0.0.1:5555/cb")).toBe(true);
    expect(OAuth.isLocalRedirectUri("https://claude.ai/cb")).toBe(false);
  });

  it("matches redirect URIs exactly, except a loopback redirect's port", () => {
    const web = "https://claude.ai/api/mcp/auth_callback";
    expect(OAuth.redirectMatches(web, web)).toBe(true);
    expect(OAuth.redirectMatches(web, `${web}/`)).toBe(false);
    expect(OAuth.redirectMatches(web, "https://CLAUDE.ai/api/mcp/auth_callback")).toBe(false);
    expect(OAuth.redirectMatches(web, `${web}?next=x`)).toBe(false);
    expect(OAuth.redirectMatches("https://claude.ai:443/cb", "https://claude.ai:8443/cb")).toBe(
      false,
    );

    const local = "http://127.0.0.1:5555/callback";
    expect(OAuth.redirectMatches(local, "http://127.0.0.1:61234/callback")).toBe(true);
    expect(OAuth.redirectMatches("http://localhost/callback", "http://localhost:9/callback")).toBe(
      true,
    );
    expect(OAuth.redirectMatches(local, "http://127.0.0.1:61234/other")).toBe(false);
    expect(OAuth.redirectMatches(local, "http://localhost:5555/callback")).toBe(false);
    expect(OAuth.redirectMatches(local, "http://127.0.0.1:5555/callback?x=1")).toBe(false);
    expect(OAuth.redirectMatches(local, "http://127.0.0.1:5555/callback#x")).toBe(false);
    expect(OAuth.redirectMatches(local, "https://127.0.0.1:5555/callback")).toBe(false);
  });

  it("reads the scope parameter's tokens", () => {
    expect(OAuth.scopeTokens("aliases:read  contacts:read aliases:read")).toEqual([
      "aliases:read",
      "contacts:read",
    ]);
    expect(OAuth.scopeTokens("")).toEqual([]);
  });
});
