import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { WebhookUrl } from "../src/index.ts";

const production = { isLoopbackAllowed: false };
const dev = { isLoopbackAllowed: true };

const refusal = (url: string, options = production) =>
  Result.match(WebhookUrl.check(url, options), {
    onFailure: (reason) => reason,
    onSuccess: () => "ok",
  });

describe("WebhookUrl.check", () => {
  it("accepts https URLs on public hosts", () => {
    expect(refusal("https://hooks.example.com/alias?x=1")).toBe("ok");
    expect(refusal("https://hooks.example.com:8443/in")).toBe("ok");
    expect(refusal("https://93.184.215.14/hook")).toBe("ok");
    expect(refusal("https://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/hook")).toBe("ok");
  });

  it("refuses anything but https in production, and credentials always", () => {
    expect(refusal("http://hooks.example.com/")).toBe("not-https");
    expect(refusal("ftp://hooks.example.com/")).toBe("invalid-url");
    expect(refusal("not a url")).toBe("invalid-url");
    expect(refusal("https://user:pass@hooks.example.com/")).toBe("has-credentials");
    expect(refusal(`https://hooks.example.com/${"a".repeat(2_048)}`)).toBe("too-long");
  });

  it("refuses private, loopback, link-local and metadata addresses, however they're spelled", () => {
    const hosts = [
      "127.0.0.1",
      "127.1",
      "0x7f.0.0.1",
      "2130706433",
      "10.0.0.8",
      "172.20.1.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "[::1]",
      "[::]",
      "[::ffff:127.0.0.1]",
      "[::ffff:a9fe:a9fe]",
      "[64:ff9b::a9fe:a9fe]",
      "[fd00:ec2::254]",
      "[fe80::1]",
      "[2002:a9fe:a9fe::1]",
      "[2001::1]",
      "[3fff::1]",
      "[5f00::1]",
      "localhost",
      "localhost.",
      "api.localhost.",
      "api.localhost",
      "intranet",
      "intranet.",
    ];
    expect(Arr.map(hosts, (host) => refusal(`https://${host}/hook`))).toEqual(
      Arr.replicate("not-public-host", hosts.length),
    );
  });

  it("lets tests and dev post to loopback, over http too, and nowhere else private", () => {
    expect(refusal("http://127.0.0.1:41000/hook", dev)).toBe("ok");
    expect(refusal("http://localhost:41000/hook", dev)).toBe("ok");
    expect(refusal("http://[::1]:41000/hook", dev)).toBe("ok");
    expect(refusal("http://10.0.0.8/hook", dev)).toBe("not-https");
    expect(refusal("https://169.254.169.254/hook", dev)).toBe("not-public-host");
  });
});

describe("WebhookUrl.isAllowedAddress (what DNS returned)", () => {
  it("allows global unicast only, and loopback when asked", () => {
    expect(WebhookUrl.isAllowedAddress("93.184.215.14", production)).toBe(true);
    expect(WebhookUrl.isAllowedAddress("2606:4700::6810:84e5", production)).toBe(true);
    expect(WebhookUrl.isAllowedAddress("::ffff:93.184.215.14", production)).toBe(true);
    expect(WebhookUrl.isAllowedAddress("64:ff9b::5db8:d70e", production)).toBe(true);
    const blocked = ["10.1.2.3", "169.254.169.254", "fe80::1%eth0", "fc00::1", "::1", "garbage"];
    expect(Arr.map(blocked, (address) => WebhookUrl.isAllowedAddress(address, production))).toEqual(
      Arr.replicate(false, blocked.length),
    );
    expect(WebhookUrl.isAllowedAddress("127.0.0.1", dev)).toBe(true);
    expect(WebhookUrl.isAllowedAddress("::1", dev)).toBe(true);
    expect(WebhookUrl.isAllowedAddress("10.1.2.3", dev)).toBe(false);
  });
});
