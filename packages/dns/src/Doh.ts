import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/**
 * DNS over HTTPS in the JSON format Google defined and Cloudflare follows (there is no RFC for it;
 * RFC 8484 covers only the wire format). One GET per question:
 * `<url>?name=<name>&type=<type>` with `accept: application/dns-json`.
 * https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
 * https://developers.google.com/speed/public-dns/docs/doh/json
 */

/** Cloudflare's resolver, the production default. */
export const cloudflare = "https://cloudflare-dns.com/dns-query";

/** The record types the domain checks ask for, with their IANA numbers. */
export const types = { CNAME: 5, SOA: 6, MX: 15, TXT: 16 } as const;
export type QueryType = "CNAME" | "MX" | "TXT";

const ResourceRecord = Schema.Struct({
  name: Schema.String,
  type: Schema.Int,
  /** Google's documented TXT example has none. */
  TTL: Schema.optionalKey(Schema.Int),
  data: Schema.String,
});

// The flag names are the format's own, not ours to choose.
/* oxlint-disable effect/require-is-prefix-for-boolean-schema-field */
/** A resolver's answer to one question, as both providers document and send it. */
export const Response = Schema.Struct({
  /** The DNS RCODE: 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN, … */
  Status: Schema.Int,
  TC: Schema.Boolean,
  RD: Schema.Boolean,
  RA: Schema.Boolean,
  AD: Schema.Boolean,
  CD: Schema.Boolean,
  Question: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.Int })),
  Answer: Schema.optionalKey(Schema.Array(ResourceRecord)),
  Authority: Schema.optionalKey(Schema.Array(ResourceRecord)),
  Additional: Schema.optionalKey(Schema.Array(ResourceRecord)),
  Comment: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  edns_client_subnet: Schema.optionalKey(Schema.String),
});
/* oxlint-enable effect/require-is-prefix-for-boolean-schema-field */
export type Response = typeof Response.Type;

/** The resolver couldn't say whether the record exists: network, HTTP, SERVFAIL, truncation. */
export class DnsUnavailable extends Schema.TaggedError<DnsUnavailable>()("DnsUnavailable", {
  name: Schema.String,
  type: Schema.String,
  reason: Schema.String,
}) {}

const NOERROR = 0;
const NXDOMAIN = 3;

/** Lowercase, without the root's trailing dot: `Inbound-SMTP.example.com.` → `inbound-smtp.example.com`. */
export const normalizeName = (name: string): string =>
  Str.toLowerCase(name.endsWith(".") ? name.slice(0, -1) : name);

/**
 * A TXT record's text. Cloudflare prints each character-string quoted (`"a" "b"`), Google's
 * documented example quotes them without a space between (`"a""b"`), and Google's real answers
 * print the text unquoted. Character-strings are joined without a separator, as SPF (RFC 7208
 * §3.3) and DKIM read them; `\"` and `\\` are unescaped.
 */
export const txtText = (data: string): string => {
  if (!data.startsWith('"')) return data;
  const strings = Arr.map(Arr.fromIterable(data.matchAll(/"((?:[^"\\]|\\.)*)"/g)), (match) =>
    (match[1] ?? "").replace(/\\(.)/g, "$1"),
  );
  return Arr.join(strings, "");
};

export interface Mx {
  readonly preference: number;
  /** Normalized (see {@link normalizeName}); `""` for a null MX (RFC 7505: `0 .`). */
  readonly exchange: string;
}

/** `10 inbound-smtp.eu-west-1.amazonaws.com.`; None when the data isn't an MX record. */
export const mxRecord = (data: string): Option.Option<Mx> => {
  const match = /^(\d+)\s+(\S+)$/.exec(data.trim());
  return match === null
    ? Option.none()
    : Option.some({ preference: Number(match[1]), exchange: normalizeName(match[2] ?? "") });
};

/**
 * The data of the answers of the asked type. A missing name (NXDOMAIN) and a name without that
 * type both give none; a CNAME the resolver followed is skipped unless CNAMEs were asked for.
 */
export const answers = (
  response: Response,
  type: QueryType,
): Effect.Effect<ReadonlyArray<string>, DnsUnavailable> => {
  const name = Option.getOrElse(
    Option.map(Arr.head(response.Question), (question) => question.name),
    () => "",
  );
  const unavailable = (reason: string) => Effect.fail(new DnsUnavailable({ name, type, reason }));
  if (response.TC) return unavailable("truncated");
  if (response.Status === NXDOMAIN) return Effect.succeed([]);
  if (response.Status !== NOERROR) return unavailable(`rcode ${response.Status}`);
  return Effect.succeed(
    Arr.map(
      Arr.filter(response.Answer ?? [], (record) => record.type === types[type]),
      (record) => record.data,
    ),
  );
};

/** Looks names up; each method answers with what is published now (an empty list if nothing). */
export class Resolver extends Context.Service<
  Resolver,
  {
    readonly mx: (name: string) => Effect.Effect<ReadonlyArray<Mx>, DnsUnavailable>;
    /** Each TXT record's text, its character-strings joined. */
    readonly txt: (name: string) => Effect.Effect<ReadonlyArray<string>, DnsUnavailable>;
    /** Normalized targets. */
    readonly cname: (name: string) => Effect.Effect<ReadonlyArray<string>, DnsUnavailable>;
  }
>()("@alias/dns/Resolver") {}

const decodeResponse = HttpClientResponse.schemaBodyJson(Response);

const make = Effect.fn("Doh.make")(function* (url: string) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const query = (name: string, type: QueryType) =>
    client
      .get(url, {
        urlParams: { name, type },
        headers: { accept: "application/dns-json" },
      })
      .pipe(
        Effect.flatMap(decodeResponse),
        Effect.mapError((cause) => new DnsUnavailable({ name, type, reason: String(cause) })),
        Effect.flatMap((response) => answers(response, type)),
      );
  return Resolver.of({
    mx: (name) => Effect.map(query(name, "MX"), (found) => Arr.getSomes(Arr.map(found, mxRecord))),
    txt: (name) => Effect.map(query(name, "TXT"), Arr.map(txtText)),
    cname: (name) => Effect.map(query(name, "CNAME"), Arr.map(normalizeName)),
  });
});

/** A resolver at `url`: Cloudflare in production, `tools/doh-emulator` in tests and dev. */
export const layer = (url: string): Layer.Layer<Resolver> =>
  Layer.effect(Resolver, make(url)).pipe(Layer.provide(FetchHttpClient.layer));

/** `ALIAS_DOH_URL`, Cloudflare's resolver when unset. */
export const config = Config.String("ALIAS_DOH_URL").pipe(
  Config.withDefault(cloudflare),
  Config.map(layer),
);
