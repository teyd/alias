import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import { DomainSetup } from "../src/index.ts";

const setup: DomainSetup.Setup = {
  domain: "custom.example",
  verificationToken: "tok123",
  dkimTokens: ["aaa", "bbb", "ccc"],
  dkimZone: DomainSetup.defaultDkimZone,
};

const records = DomainSetup.records(setup);
const ownership: DomainSetup.DnsRecord = {
  purpose: "ownership",
  isRequired: true,
  type: "TXT",
  name: "custom.example",
  value: "alias-verification=tok123",
};
const firstDkim: DomainSetup.DnsRecord = {
  purpose: "dkim",
  isRequired: true,
  type: "CNAME",
  name: "aaa._domainkey.custom.example",
  value: "aaa.dkim.amazonses.com",
};
const mx = (preference: number, exchange: string) => ({ preference, exchange });

describe("DomainSetup.records", () => {
  it("lists the documented SES records and the claim's ownership token", () => {
    expect(records).toEqual([
      {
        purpose: "ownership",
        isRequired: true,
        type: "TXT",
        name: "custom.example",
        value: "alias-verification=tok123",
      },
      {
        purpose: "receiving",
        isRequired: true,
        type: "MX",
        name: "custom.example",
        value: "inbound-smtp.eu-west-1.amazonaws.com",
        priority: 10,
      },
      ...Arr.map(["aaa", "bbb", "ccc"], (token) => ({
        purpose: "dkim",
        isRequired: true,
        type: "CNAME",
        name: `${token}._domainkey.custom.example`,
        value: `${token}.dkim.amazonses.com`,
      })),
      {
        purpose: "mail-from",
        isRequired: false,
        type: "MX",
        name: "bounce.custom.example",
        value: "feedback-smtp.eu-west-1.amazonses.com",
        priority: 10,
      },
      {
        purpose: "mail-from",
        isRequired: false,
        type: "TXT",
        name: "bounce.custom.example",
        value: "v=spf1 include:amazonses.com ~all",
      },
      {
        purpose: "dmarc",
        isRequired: false,
        type: "TXT",
        name: "_dmarc.custom.example",
        value: "v=DMARC1; p=none",
      },
    ]);
  });

  it("points DKIM at SES's hosted zone when it names one", () => {
    const zoned = DomainSetup.records({ ...setup, dkimZone: "dkim.eu-west-1.amazonses.com" });
    expect(zoned[2]?.value).toBe("aaa.dkim.eu-west-1.amazonses.com");
  });
});

describe("DomainSetup.judge", () => {
  it("finds the ownership token among other TXT records, and only the exact one", () => {
    expect(
      DomainSetup.judge.ownership(ownership, ["v=spf1 -all", "alias-verification=tok123"]),
    ).toBe("ok");
    expect(DomainSetup.judge.ownership(ownership, ["alias-verification=other"])).toBe("missing");
    expect(DomainSetup.judge.ownership(ownership, [])).toBe("missing");
  });

  it("needs every most-preferred MX to be SES inbound", () => {
    const ses = DomainSetup.inboundHost;
    expect(DomainSetup.judge.receiving([mx(10, ses)])).toBe("ok");
    expect(DomainSetup.judge.receiving([mx(10, ses), mx(20, "backup.example")])).toBe("ok");
    expect(DomainSetup.judge.receiving([mx(10, ses), mx(10, "other.example")])).toBe("wrong");
    expect(DomainSetup.judge.receiving([mx(5, "mx.other.example"), mx(10, ses)])).toBe("wrong");
    expect(DomainSetup.judge.receiving([mx(0, "")])).toBe("wrong");
    expect(DomainSetup.judge.receiving([])).toBe("missing");
  });

  it("matches each DKIM CNAME to its own token", () => {
    expect(DomainSetup.judge.dkim(firstDkim, ["aaa.dkim.amazonses.com"])).toBe("ok");
    expect(DomainSetup.judge.dkim(firstDkim, ["bbb.dkim.amazonses.com"])).toBe("wrong");
    expect(DomainSetup.judge.dkim(firstDkim, [])).toBe("missing");
  });

  it("wants exactly one MAIL FROM MX, SES's feedback endpoint", () => {
    const feedback = DomainSetup.feedbackHost;
    expect(DomainSetup.judge.mailFromMx([mx(10, feedback)])).toBe("ok");
    expect(DomainSetup.judge.mailFromMx([mx(10, feedback), mx(20, feedback)])).toBe("wrong");
    expect(DomainSetup.judge.mailFromMx([])).toBe("missing");
  });

  it("wants one SPF policy that includes SES", () => {
    expect(DomainSetup.judge.mailFromSpf(["v=spf1 include:amazonses.com ~all"])).toBe("ok");
    expect(DomainSetup.judge.mailFromSpf(["V=SPF1 Include:AmazonSES.com -all", "other"])).toBe(
      "ok",
    );
    expect(DomainSetup.judge.mailFromSpf(["v=spf1 -all"])).toBe("wrong");
    expect(
      DomainSetup.judge.mailFromSpf(["v=spf1 include:amazonses.com ~all", "v=spf1 -all"]),
    ).toBe("wrong");
    expect(DomainSetup.judge.mailFromSpf(["unrelated"])).toBe("missing");
  });

  it("accepts any DMARC policy", () => {
    expect(DomainSetup.judge.dmarc(["v=DMARC1;p=reject"])).toBe("ok");
    expect(DomainSetup.judge.dmarc(["v = DMARC1; p=none"])).toBe("ok");
    expect(DomainSetup.judge.dmarc(["v=spf1 -all"])).toBe("missing");
  });
});

describe("DomainSetup.verdict", () => {
  const all = (state: DomainSetup.CheckState) =>
    Arr.map(records, (record): DomainSetup.Check => ({ record, state }));

  it("is ready when every required record is ok, whatever the recommended ones say", () => {
    const checks = Arr.map(records, (record): DomainSetup.Check => ({
      record,
      state: record.isRequired ? "ok" : "missing",
    }));
    expect(DomainSetup.verdict(checks)).toBe("ready");
  });

  it("is not ready when a required record is missing or wrong, even if another is unknown", () => {
    const checks = Arr.map(all("ok"), (check, index) =>
      index === 0
        ? { ...check, state: "unknown" as const }
        : index === 1
          ? { ...check, state: "wrong" as const }
          : check,
    );
    expect(DomainSetup.verdict(checks)).toBe("not-ready");
    expect(DomainSetup.verdict(all("missing"))).toBe("not-ready");
  });

  it("is inconclusive when only lookups failed", () => {
    expect(DomainSetup.verdict(all("unknown"))).toBe("inconclusive");
  });
});

describe("DomainSetup.zoneFile", () => {
  it("writes every record as an absolute BIND line, required ones first", () => {
    const shuffled = [
      ...Arr.filter(records, (r) => !r.isRequired),
      ...Arr.filter(records, (r) => r.isRequired),
    ];
    expect(DomainSetup.zoneFile("custom.example", shuffled).split("\n")).toEqual([
      "; DNS records for custom.example, from Alias. Required records first, then recommended ones.",
      'custom.example.\t3600\tIN\tTXT\t"alias-verification=tok123" ; Alias: proves the domain is yours (required)',
      "custom.example.\t3600\tIN\tMX\t10 inbound-smtp.eu-west-1.amazonaws.com. ; Alias: delivers the domain's mail to Alias (required)",
      "aaa._domainkey.custom.example.\t3600\tIN\tCNAME\taaa.dkim.amazonses.com. ; Alias: DKIM, signs mail sent from the domain (required) cf_tags=cf-proxied:false",
      "bbb._domainkey.custom.example.\t3600\tIN\tCNAME\tbbb.dkim.amazonses.com. ; Alias: DKIM, signs mail sent from the domain (required) cf_tags=cf-proxied:false",
      "ccc._domainkey.custom.example.\t3600\tIN\tCNAME\tccc.dkim.amazonses.com. ; Alias: DKIM, signs mail sent from the domain (required) cf_tags=cf-proxied:false",
      "bounce.custom.example.\t3600\tIN\tMX\t10 feedback-smtp.eu-west-1.amazonses.com. ; Alias: MAIL FROM, bounces and SPF alignment (recommended)",
      'bounce.custom.example.\t3600\tIN\tTXT\t"v=spf1 include:amazonses.com ~all" ; Alias: MAIL FROM, bounces and SPF alignment (recommended)',
      '_dmarc.custom.example.\t3600\tIN\tTXT\t"v=DMARC1; p=none" ; Alias: DMARC policy (recommended)',
      "",
    ]);
  });

  it("splits long TXT values into quoted strings of at most 255 characters", () => {
    const long: DomainSetup.DnsRecord = { ...ownership, value: "a".repeat(300) };
    expect(DomainSetup.zoneFile("custom.example", [long])).toContain(
      `\tTXT\t"${"a".repeat(255)}" "${"a".repeat(45)}" ;`,
    );
  });

  it("escapes quotes and backslashes in TXT values", () => {
    const odd: DomainSetup.DnsRecord = { ...ownership, value: 'say "hi" \\o/' };
    expect(DomainSetup.zoneFile("custom.example", [odd])).toContain(
      '\tTXT\t"say \\"hi\\" \\\\o/" ;',
    );
  });

  it("keeps names and targets that are already absolute", () => {
    const dotted: DomainSetup.DnsRecord = {
      ...firstDkim,
      name: "aaa._domainkey.custom.example.",
      value: "aaa.dkim.amazonses.com.",
    };
    expect(DomainSetup.zoneFile("custom.example", [dotted])).toContain(
      "aaa._domainkey.custom.example.\t3600\tIN\tCNAME\taaa.dkim.amazonses.com. ;",
    );
  });
});
