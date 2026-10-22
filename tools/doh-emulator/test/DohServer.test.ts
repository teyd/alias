import { Doh, DomainSetup } from "@alias/dns";
import cname from "@alias/dns/fixtures/recorded-cloudflare-cname.json" with { type: "json" };
import dmarc from "@alias/dns/fixtures/recorded-cloudflare-dmarc.json" with { type: "json" };
import badName from "@alias/dns/fixtures/recorded-cloudflare-error.json" with { type: "json" };
import noName from "@alias/dns/fixtures/recorded-cloudflare-error-name.json" with { type: "json" };
import badType from "@alias/dns/fixtures/recorded-cloudflare-error-type.json" with { type: "json" };
import mx from "@alias/dns/fixtures/recorded-cloudflare-mx.json" with { type: "json" };
import mxCase from "@alias/dns/fixtures/recorded-cloudflare-mx-case.json" with { type: "json" };
import nodata from "@alias/dns/fixtures/recorded-cloudflare-nodata.json" with { type: "json" };
import nullMx from "@alias/dns/fixtures/recorded-cloudflare-null-mx.json" with { type: "json" };
import nxdomain from "@alias/dns/fixtures/recorded-cloudflare-nxdomain.json" with { type: "json" };
import txtViaCname from "@alias/dns/fixtures/recorded-cloudflare-txt-via-cname.json" with { type: "json" };
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Num from "effect/Number";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { DohServer, type ZoneRecord } from "../src/index.ts";

const decode = Schema.decodeUnknownEffect(Doh.Response);

/** A followed CNAME first, then by data: resolvers shuffle the records of one type. */
interface Answered {
  readonly type: number;
  readonly data: string;
}
const answerOrder = Order.combine(
  Order.mapInput(Num.Order, (record: Answered) => (record.type === 5 ? 0 : 1)),
  Order.mapInput(Str.Order, (record: Answered) => record.data),
);

/** The fields a resolver must get right; TTLs, the DNSSEC flag and SOA contents vary by zone. */
const essentials = (response: Doh.Response) => ({
  Status: response.Status,
  TC: response.TC,
  RD: response.RD,
  RA: response.RA,
  CD: response.CD,
  Question: response.Question,
  // Resolvers shuffle records of one type; a followed CNAME stays first.
  Answer: Arr.sort(
    Arr.map(response.Answer ?? [], ({ name, type, data }) => ({ name, type, data })),
    answerOrder,
  ),
  Authority: Arr.map(response.Authority ?? [], ({ name, type }) => ({ name, type })),
});

const get = (url: string, headers: Record<string, string> = { accept: "application/dns-json" }) =>
  Effect.promise(async () => {
    const response = await fetch(url, { headers });
    return { status: response.status, text: await response.text() };
  });

const ask = (name: string, type: string) =>
  Effect.gen(function* () {
    const server = yield* DohServer.DohServer;
    const query = new URLSearchParams({ name, type });
    const { status, text } = yield* get(`${server.url}?${query}`);
    expect(status).toBe(200);
    return yield* decode(JSON.parse(text));
  });

/** The fixture's answers as zone records, TXT texts read back with the production parser. */
const recordsOf = (fixture: Doh.Response): ReadonlyArray<ZoneRecord> =>
  Arr.map(fixture.Answer ?? [], (record): ZoneRecord => {
    const type = record.type === 5 ? "CNAME" : record.type === 15 ? "MX" : "TXT";
    return {
      name: record.name,
      type,
      data: type === "TXT" ? Doh.txtText(record.data) : record.data,
    };
  });

/** Sets up zones holding what the recorded answer showed, asks the same, compares. */
const replay = (
  fixture: Schema.Json,
  zones: ReadonlyArray<{ readonly apex: string; readonly records: ReadonlyArray<ZoneRecord> }>,
  query: { readonly name: string; readonly type: string },
) =>
  Effect.gen(function* () {
    const recorded = yield* decode(fixture);
    const server = yield* DohServer.DohServer;
    yield* Effect.forEach(zones, (zone) => server.setZone(zone.apex, zone.records), {
      concurrency: 1,
      discard: true,
    });
    const emulated = yield* ask(query.name, query.type);
    expect(essentials(emulated)).toEqual(essentials(recorded));
    yield* Effect.forEach(zones, (zone) => server.removeZone(zone.apex), {
      concurrency: 1,
      discard: true,
    });
  });

describe("DohServer (contract: answers Cloudflare's resolver was recorded giving)", () => {
  it.layer(DohServer.layer(), { timeout: 30_000 })((it) => {
    it.effect("MX records, in any query letter case", () =>
      Effect.gen(function* () {
        const recorded = yield* decode(mx);
        const zone = [{ apex: "gmail.com", records: recordsOf(recorded) }];
        yield* replay(mx, zone, { name: "gmail.com", type: "MX" });
        yield* replay(mxCase, zone, { name: "GMail.com.", type: "mx" });
      }),
    );

    it.effect("TXT through a CNAME, long strings split at 255 characters", () =>
      Effect.gen(function* () {
        const records = recordsOf(yield* decode(txtViaCname));
        yield* replay(txtViaCname, [{ apex: "github.com", records }], {
          name: "www.github.com",
          type: "TXT",
        });
        yield* replay(cname, [{ apex: "github.com", records }], {
          name: "www.github.com",
          type: "CNAME",
        });
      }),
    );

    it.effect("a null MX and a DMARC record", () =>
      Effect.gen(function* () {
        yield* replay(
          nullMx,
          [{ apex: "example.com", records: recordsOf(yield* decode(nullMx)) }],
          {
            name: "example.com",
            type: "MX",
          },
        );
        yield* replay(dmarc, [{ apex: "example.com", records: recordsOf(yield* decode(dmarc)) }], {
          name: "_dmarc.example.com",
          type: "TXT",
        });
      }),
    );

    it.effect("NXDOMAIN and no data, each with the zone's SOA", () =>
      Effect.gen(function* () {
        yield* replay(nxdomain, [{ apex: "com", records: [] }], {
          name: "zz9q-nonexistent-domain-alias.com",
          type: "MX",
        });
        yield* replay(
          nodata,
          [
            {
              apex: "github.com",
              records: [{ name: "github.com", type: "A", data: "140.82.121.4" }],
            },
          ],
          { name: "github.com", type: "AAAA" },
        );
      }),
    );

    it.effect("an empty non-terminal exists (RFC 8020)", () =>
      Effect.gen(function* () {
        const server = yield* DohServer.DohServer;
        yield* server.setZone("custom.example", [
          { name: "a._domainkey.custom.example", type: "CNAME", data: "a.dkim.amazonses.com" },
        ]);
        expect((yield* ask("_domainkey.custom.example", "TXT")).Status).toBe(0);
        expect((yield* ask("other.custom.example", "TXT")).Status).toBe(3);
      }),
    );

    it.effect("the recorded 400s, and an empty 400 without the JSON accept header", () =>
      Effect.gen(function* () {
        const { url } = yield* DohServer.DohServer;
        const cases = [
          { query: "name=bad..name&type=MX", body: badName },
          { query: "name=gmail.com&type=BOGUS", body: badType },
          { query: "type=MX", body: noName },
        ];
        yield* Effect.forEach(
          cases,
          ({ query, body }) =>
            Effect.map(get(`${url}?${query}`), (response) => {
              expect(response.status).toBe(400);
              expect(JSON.parse(response.text)).toEqual(body);
            }),
          { concurrency: 1, discard: true },
        );
        expect(yield* get(`${url}?name=gmail.com&type=MX`, {})).toEqual({ status: 400, text: "" });
      }),
    );

    it.effect("zones can be set over HTTP (dev)", () =>
      Effect.gen(function* () {
        const { url } = yield* DohServer.DohServer;
        const zones = url.replace("/dns-query", "/_emulator/zones");
        const put = yield* Effect.promise(() =>
          fetch(`${zones}/dev.example`, {
            method: "PUT",
            body: JSON.stringify([{ name: "dev.example", type: "TXT", data: "hello" }]),
          }),
        );
        expect(put.status).toBe(200);
        expect(Arr.map((yield* ask("dev.example", "TXT")).Answer ?? [], (r) => r.data)).toEqual([
          '"hello"',
        ]);
        yield* Effect.promise(() => fetch(`${zones}/dev.example`, { method: "DELETE" }));
        expect((yield* ask("dev.example", "TXT")).Status).toBe(3);
      }),
    );
  });
});

describe("Doh.layer and DomainSetup.check on the emulator", () => {
  const setup: DomainSetup.Setup = {
    domain: "custom.example",
    verificationToken: "tok",
    dkimTokens: ["t1", "t2", "t3"],
    dkimZone: DomainSetup.defaultDkimZone,
  };
  /** What a user following the wizard publishes. */
  const published: ReadonlyArray<ZoneRecord> = Arr.map(DomainSetup.records(setup), (record) => ({
    name: record.name,
    type: record.type,
    data: record.type === "MX" ? `${record.priority ?? 10} ${record.value}` : record.value,
  }));
  const resolver = Layer.unwrap(
    Effect.map(Effect.service(DohServer.DohServer), (server) => Doh.layer(server.url)),
  );

  it.layer(Layer.provideMerge(resolver, DohServer.layer()), { timeout: 30_000 })((it) => {
    it.effect("reads MX, TXT and CNAME records as published", () =>
      Effect.gen(function* () {
        const server = yield* DohServer.DohServer;
        const dns = yield* Doh.Resolver;
        yield* server.setZone("custom.example", published);
        expect(yield* dns.mx("custom.example")).toEqual([
          { preference: 10, exchange: DomainSetup.inboundHost },
        ]);
        expect(yield* dns.txt("custom.example")).toEqual(["alias-verification=tok"]);
        expect(yield* dns.cname("t1._domainkey.custom.example")).toEqual(["t1.dkim.amazonses.com"]);
        expect(yield* dns.txt("nothing.custom.example")).toEqual([]);
      }),
    );

    it.effect("checks a domain from nothing published to ready", () =>
      Effect.gen(function* () {
        const server = yield* DohServer.DohServer;
        yield* server.setZone("custom.example", []);
        const before = yield* DomainSetup.check(setup);
        expect(Arr.dedupe(Arr.map(before, (check) => check.state))).toEqual(["missing"]);
        expect(DomainSetup.verdict(before)).toBe("not-ready");

        yield* server.setZone("custom.example", published);
        const after = yield* DomainSetup.check(setup);
        expect(Arr.dedupe(Arr.map(after, (check) => check.state))).toEqual(["ok"]);
        expect(DomainSetup.verdict(after)).toBe("ready");
      }),
    );
  });

  it.layer(Doh.layer("http://127.0.0.1:9/dns-query"), { timeout: 30_000 })((it) => {
    it.effect("a resolver that can't be reached makes every check unknown", () =>
      Effect.gen(function* () {
        const checks = yield* DomainSetup.check(setup);
        expect(Arr.dedupe(Arr.map(checks, (check) => check.state))).toEqual(["unknown"]);
        expect(DomainSetup.verdict(checks)).toBe("inconclusive");
      }),
    );
  });
});
