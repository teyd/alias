import { describe, expect, it } from "@effect/vitest";
import { rateLimitKey } from "../src/ClientAddress.ts";

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
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
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
