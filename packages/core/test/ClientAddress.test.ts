import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { ClientAddress } from "../src/index.ts";

const { rateLimitKey } = ClientAddress;
const key = rateLimitKey;

describe("ClientAddress", () => {
  it.each<readonly [string, string]>([
    ["192.0.2.1", "192.0.2.1"],
    ["::ffff:192.0.2.1", "192.0.2.1"],
    ["::ffff:c000:201", "192.0.2.1"],
    ["2001:DB8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["2001:db8:0:0:0:0:2:1", "2001:db8::2:1"],
    ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
    ["2001:0:0:1:0:0:0:1", "2001:0:0:1::1"],
    ["::", "::"],
    ["::1", "::1"],
  ])("writes %s as %s", (text, canonical) => {
    expect(Option.map(ClientAddress.parse(text), ClientAddress.format)).toEqual(
      Option.some(canonical),
    );
  });

  it.each(["", "192.0.2", "192.0.2.256", "1.2.3.4.5", "2001:db8::1::2", "fe80::1%en0", "[::1]"])(
    "refuses %j",
    (text) => {
      expect(Option.isNone(ClientAddress.parse(text))).toBe(true);
    },
  );

  it("keys IPv4 by address and IPv6 by its /64, however it is written", () => {
    expect(key("198.51.100.7")).toBe("198.51.100.7");
    expect(key("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(key("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(key("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(key("2001:0DB8:0001:0002:0:0:0:ffff")).toBe("2001:db8:1:2::/64");
    expect(key("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
  });
});

describe("ClientAddress.rateLimitKey", () => {
  it("keeps an IPv4 address whole", () => {
    expect(rateLimitKey("192.0.2.1")).toBe("192.0.2.1");
    expect(rateLimitKey("192.0.2.2")).not.toBe(rateLimitKey("192.0.2.1"));
  });

  it("counts every address of one IPv6 /64 as one", () => {
    const key = rateLimitKey("2001:db8:1:2::1");
    expect(key).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(key);
    expect(rateLimitKey("2001:0DB8:0001:0002:abcd::9")).toBe(key);
    expect(rateLimitKey("2001:db8:1:2::1%eth0")).toBe(key);
  });

  it("keeps neighboring /64s apart", () => {
    expect(rateLimitKey("2001:db8:1:3::1")).not.toBe(rateLimitKey("2001:db8:1:2::1"));
    expect(rateLimitKey("::1")).toBe("::/64");
  });

  it("counts an IPv4-mapped IPv6 address as its IPv4 address", () => {
    expect(rateLimitKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(rateLimitKey("::ffff:c000:201")).toBe("192.0.2.1");
  });

  it("keeps what isn't an address as given", () => {
    expect(rateLimitKey("unknown")).toBe("unknown");
    expect(rateLimitKey("2001:db8::1::2")).toBe("2001:db8::1::2");
  });
});
