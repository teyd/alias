import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import cloudflareExample from "../fixtures/cloudflare-example.json" with { type: "json" };
import cloudflareError from "../fixtures/cloudflare-error.json" with { type: "json" };
import googleA from "../fixtures/google-a.json" with { type: "json" };
import googleServfail from "../fixtures/google-servfail.json" with { type: "json" };
import googleSpf from "../fixtures/google-spf.json" with { type: "json" };
import googleTxt from "../fixtures/google-txt.json" with { type: "json" };
import cname from "../fixtures/recorded-cloudflare-cname.json" with { type: "json" };
import dmarc from "../fixtures/recorded-cloudflare-dmarc.json" with { type: "json" };
import recordedError from "../fixtures/recorded-cloudflare-error.json" with { type: "json" };
import mx from "../fixtures/recorded-cloudflare-mx.json" with { type: "json" };
import nodata from "../fixtures/recorded-cloudflare-nodata.json" with { type: "json" };
import nullMx from "../fixtures/recorded-cloudflare-null-mx.json" with { type: "json" };
import nxdomain from "../fixtures/recorded-cloudflare-nxdomain.json" with { type: "json" };
import cloudflareTxt from "../fixtures/recorded-cloudflare-txt-via-cname.json" with { type: "json" };
import googleRecordedTxt from "../fixtures/recorded-google-txt-via-cname.json" with { type: "json" };
import { Doh } from "../src/index.ts";

const decode = Schema.decodeUnknownEffect(Doh.Response);

const githubSpf =
  "v=spf1 ip4:192.30.252.0/22 include:spf.protection.outlook.com include:_netblocks.google.com include:_netblocks2.google.com include:mail.zendesk.com include:_spf.salesforce.com include:servers.mcsv.net include:mktomail.com include:sendgrid.net ip4:62.253.227.114 ip4:166.78.69.169 ip4:166.78.69.170 ip4:166.78.71.131 ~all";

describe("Doh.Response (contract: documented and recorded resolver answers)", () => {
  it.effect("decodes every documented and recorded answer", () =>
    Effect.forEach(
      [
        cloudflareExample,
        googleA,
        googleServfail,
        googleSpf,
        googleTxt,
        cname,
        dmarc,
        mx,
        nodata,
        nullMx,
        nxdomain,
        cloudflareTxt,
        googleRecordedTxt,
      ],
      (body) => decode(body),
      { concurrency: 1, discard: true },
    ),
  );

  it.effect("the documented and recorded error bodies are not answers", () =>
    Effect.forEach(
      [cloudflareError, recordedError],
      (body) =>
        Effect.map(Effect.flip(decode(body)), (error) => expect(error._tag).toBe("SchemaError")),
      { concurrency: 1, discard: true },
    ),
  );
});

const answers = (body: Schema.Json, type: Doh.QueryType) =>
  Effect.flatMap(decode(body), (response) => Doh.answers(response, type));

describe("Doh.answers", () => {
  it.effect("reads the asked type, skipping the CNAME the resolver followed", () =>
    Effect.gen(function* () {
      const cloudflare = Arr.map(yield* answers(cloudflareTxt, "TXT"), Doh.txtText);
      const google = Arr.map(yield* answers(googleRecordedTxt, "TXT"), Doh.txtText);
      expect(cloudflare).toContain(githubSpf);
      // Google prints TXT records unquoted, Cloudflare quoted and split at 255 characters.
      expect(google).toContain(githubSpf);
      expect(Arr.sort(cloudflare, (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(
        Arr.sort(google, (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      expect(yield* answers(cname, "CNAME")).toEqual(["github.com."]);
    }),
  );

  it.effect("treats NXDOMAIN and a name without the type as nothing published", () =>
    Effect.gen(function* () {
      expect(yield* answers(nxdomain, "MX")).toEqual([]);
      expect(yield* answers(nodata, "MX")).toEqual([]);
    }),
  );

  it.effect("fails as unavailable on SERVFAIL and on a truncated answer", () =>
    Effect.gen(function* () {
      const servfail = yield* Effect.flip(answers(googleServfail, "TXT"));
      expect(servfail).toMatchObject({ _tag: "DnsUnavailable", reason: "rcode 2" });
      const truncated = yield* Effect.flip(answers({ ...mx, TC: true }, "MX"));
      expect(truncated).toMatchObject({ _tag: "DnsUnavailable", reason: "truncated" });
    }),
  );
});

describe("record data", () => {
  it.effect("parses MX records, including the null MX", () =>
    Effect.gen(function* () {
      const parsed = Arr.getSomes(Arr.map(yield* answers(mx, "MX"), Doh.mxRecord));
      expect(Arr.findFirst(parsed, (record) => record.preference === 5)).toEqual(
        Option.some({ preference: 5, exchange: "gmail-smtp-in.l.google.com" }),
      );
      expect(Arr.map(yield* answers(nullMx, "MX"), Doh.mxRecord)).toEqual([
        Option.some({ preference: 0, exchange: "" }),
      ]);
      expect(Doh.mxRecord("not an mx")).toEqual(Option.none());
    }),
  );

  it("joins character-strings and unescapes quotes", () => {
    expect(Doh.txtText(googleTxt.Answer[0]?.data ?? "")).toBe(
      "k=rsa;  p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDrEee0Ri4Juz+QfiWYui/E9UGSXau/2P8LjnTD8V4Unn+2FAZVGE3kL23bzeoULYv4PeleB3gfmJiDJOKU3Ns5L4KJAUUHjFwDebt0NP+sBK0VKeTATL2Yr/S3bT/xhy+1xtj4RkdV7fVxTn56Lb4udUnwuxK4V5b5PdOKj/+XcwIDAQAB; n=A 1024 bit key;",
    );
    expect(Doh.txtText('"say \\"hi\\"" "\\\\ok"')).toBe('say "hi"\\ok');
    expect(Doh.txtText(dmarc.Answer[0]?.data ?? "")).toBe(
      "v=DMARC1;p=reject;sp=reject;adkim=s;aspf=s",
    );
  });

  it("normalizes names", () => {
    expect(Doh.normalizeName("Inbound-SMTP.EU-west-1.amazonaws.com.")).toBe(
      "inbound-smtp.eu-west-1.amazonaws.com",
    );
    expect(Doh.normalizeName(".")).toBe("");
  });
});
