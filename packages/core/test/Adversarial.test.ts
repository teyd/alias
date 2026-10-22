import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Mail, Message, Verification } from "../src/index.ts";
import { signer } from "./support/imageProxy.ts";
import { bytes } from "./support/mime.ts";

/**
 * Mail is attacker-chosen and the inbound Lambda has 60 s for it (PLAN.md §20.25). Every pass over
 * a message must take time linear in its size: these inputs took minutes while any of them was
 * quadratic, and take well under a second each now. The budget is loose so slow CI machines pass.
 */

const BUDGET_MS = 5_000;
const SIZE = 2_000_000;

const message = (type: string, body: string, ...fields: ReadonlyArray<string>) =>
  bytes(
    [
      "From: news@store.example",
      "Subject: News",
      ...fields,
      "MIME-Version: 1.0",
      `Content-Type: ${type}`,
      "",
      body,
    ].join("\r\n"),
  );

const multipart = (count: number, part: string) =>
  message('multipart/mixed; boundary="b"', `${`--b\r\n${part}\r\n`.repeat(count)}--b--\r\n`);

/** Each level a part of the one above, with its own boundary. */
const nested = (depth: number) => {
  const levels = Array.from({ length: depth }, (_, level) => level);
  return message(
    'multipart/mixed; boundary="b0"',
    [
      ...levels.map(
        (level) => `--b${level}\r\nContent-Type: multipart/mixed; boundary="b${level + 1}"\r\n\r\n`,
      ),
      `--b${depth}\r\n\r\nhi\r\n--b${depth}--`,
      ...levels.toReversed().map((level) => `\r\n--b${level}--`),
    ].join(""),
  );
};

const cases: ReadonlyArray<{ readonly name: string; readonly raw: Uint8Array }> = [
  {
    name: "a quoted-printable part of trailing whitespace",
    raw: message(
      "text/plain",
      `${" ".repeat(SIZE)}x`,
      "Content-Transfer-Encoding: quoted-printable",
    ),
  },
  { name: "many tiny parts", raw: multipart(SIZE / 20, "\r\nhi") },
  {
    name: "many tracking pixels",
    raw: message(
      "text/html",
      '<img src="https://t.example/o.gif" width="1" height="1">'.repeat(SIZE / 60),
    ),
  },
  {
    name: "many style elements with trackers",
    raw: message(
      "text/html",
      "<style>a{background:url(https://x.list-manage.com/track/open.php)}</style>".repeat(
        SIZE / 80,
      ),
    ),
  },
  { name: "deeply nested multiparts", raw: nested(SIZE / 100) },
  { name: "a long word without an at sign", raw: message("text/plain", "a".repeat(SIZE)) },
  { name: "a run of unclosed tags", raw: message("text/html", "<".repeat(SIZE)) },
  { name: "tags without an end", raw: message("text/html", "<p\t".repeat(SIZE / 3)) },
  { name: "unclosed style elements", raw: message("text/html", "<style>".repeat(SIZE / 7)) },
  { name: "unclosed comments", raw: message("text/html", "<!--".repeat(SIZE / 4)) },
  { name: "unclosed links", raw: message("text/html", "<a href=x>".repeat(SIZE / 10)) },
  {
    name: "unclosed CSS urls",
    raw: message("text/html", `<div style="${"background:url(".repeat(SIZE / 15)}">`),
  },
  { name: "one line of codes", raw: message("text/plain", "code 123456 ".repeat(SIZE / 12)) },
  { name: "spaced digits", raw: message("text/plain", "1 ".repeat(SIZE / 2)) },
  {
    name: "many different codes",
    raw: message(
      "text/plain",
      Array.from({ length: SIZE / 20 }, (_, index) => `code ${100_000 + index}`).join("\n"),
    ),
  },
  {
    name: "many links on their own lines",
    raw: message("text/plain", "https://a.example/verify\n".repeat(SIZE / 25)),
  },
];

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    yield* effect;
    return (yield* Clock.currentTimeMillis) - start;
  });

const forward = (raw: Uint8Array) =>
  Mail.forward(raw, {
    alias: { local: "shop", domain: "alias.test" },
    sender: { name: Option.none(), address: "news@store.example" },
    token: "t0k3n",
    protection: { images: "proxy-images", isLinkCleaningEnabled: true },
    imageProxy: signer,
  }).pipe(Effect.provide(NodeCrypto.layer));

const reply = (raw: Uint8Array) =>
  Mail.reply(raw, {
    alias: { local: "shop", domain: "alias.test" },
    to: "news@store.example",
    messageId: "m1",
    owner: { addresses: ["jane.doe@gmail.example"], name: Option.some("Jane Doe") },
  });

const extract = (raw: Uint8Array) =>
  Effect.map(Message.read(raw), (content) =>
    Verification.extract({ subject: content.subject, text: content.text, html: content.html }),
  );

describe("adversarial mail is processed in linear time", () => {
  it.live.each(cases)("$name: forward, reply, read and extract", ({ raw }) =>
    Effect.gen(function* () {
      expect(yield* timed(forward(raw))).toBeLessThan(BUDGET_MS);
      expect(yield* timed(reply(raw))).toBeLessThan(BUDGET_MS);
      expect(yield* timed(extract(raw))).toBeLessThan(BUDGET_MS);
      expect(yield* timed(Mail.signals(raw))).toBeLessThan(BUDGET_MS);
    }),
  );
});

describe("the MIME walk's limits", () => {
  const pixel = '<img src="https://t.example/o.gif" width="1" height="1">';
  const htmlPart = `Content-Type: text/html\r\n\r\n${pixel}`;

  it.effect("rewrites the first 1,000 parts and passes the rest on unchanged", () =>
    Effect.gen(function* () {
      const out = new TextDecoder().decode(yield* forward(multipart(1_001, htmlPart)));
      expect(out.split(pixel)).toHaveLength(2);
    }),
  );

  it.effect("rewrites 16 levels deep and passes deeper parts on unchanged", () =>
    Effect.gen(function* () {
      const at = (depth: number) => {
        const levels = Array.from({ length: depth }, (_, level) => level);
        return message(
          'multipart/mixed; boundary="b0"',
          [
            ...levels.map(
              (level) =>
                `--b${level}\r\nContent-Type: multipart/mixed; boundary="b${level + 1}"\r\n\r\n`,
            ),
            `--b${depth}\r\n${htmlPart}\r\n--b${depth}--`,
            ...levels.toReversed().map((level) => `\r\n--b${level}--`),
          ].join(""),
        );
      };
      const shallow = new TextDecoder().decode(yield* forward(at(15)));
      const deep = new TextDecoder().decode(yield* forward(at(16)));
      expect(shallow).not.toContain(pixel);
      expect(deep).toContain(pixel);
      const read = yield* Message.read(at(16));
      expect(read.html).toEqual(Option.none());
    }),
  );
});
