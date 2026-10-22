import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Message, Verification } from "../src/index.ts";

const extract = (input: {
  readonly subject?: string;
  readonly text?: string;
  readonly html?: string;
}) =>
  Verification.extract({
    subject: Option.fromUndefinedOr(input.subject),
    text: Option.fromUndefinedOr(input.text),
    html: Option.fromUndefinedOr(input.html),
  });

const code = (input: Parameters<typeof extract>[0]) => extract(input).code;
const link = (input: Parameters<typeof extract>[0]) => extract(input).link;

describe("Verification.extract: codes", () => {
  it.each([
    ["in the subject", { subject: "482913 is your login code" }, "482913"],
    ["labelled in the text", { text: "Your verification code is 482913." }, "482913"],
    [
      "on its own line under the label",
      { text: "Use this code to sign in:\n\n482913\n" },
      "482913",
    ],
    ["grouped with a space", { text: "Your security code: 482 913" }, "482913"],
    ["grouped with a hyphen", { text: "Bestätigungscode: 482-913" }, "482913"],
    ["Google style", { subject: "G-482913 is your verification code" }, "482913"],
    [
      "one digit per table cell",
      { html: "<p>Your code</p><table><tr><td>4</td><td>8</td><td>2</td><td>9</td></tr></table>" },
      "4829",
    ],
    [
      "one digit per span",
      { html: "<p>Code:</p><div><span>4</span><span>8</span><span>2</span><span>9</span></div>" },
      "4829",
    ],
    ["alphanumeric, labelled", { text: "Your one-time code: K7Q2-M9XD" }, "K7Q2M9XD"],
    ["Japanese", { text: "確認コード：482913" }, "482913"],
    ["a year when labelled", { text: "Your PIN: 2026" }, "2026"],
  ])("finds the code %s", (_, input, expected) => {
    expect(code(input)).toEqual(Option.some(expected));
  });

  it.each([
    ["a price", { text: "Your code for €4829.00 order" }],
    ["an order number", { text: "Verification of order #482913 complete" }],
    ["a postal code", { text: "Please verify your address: postal code 10115" }],
    ["a promo code", { text: "Use discount code SAVE20 at checkout" }],
    ["a phone number", { text: "Questions about your code? Call +1 555 0100 2233" }],
    ["a year in the footer", { text: "Verify your email.\n© 2026 Example Inc." }],
    ["a date and time", { text: "Sign-in code requested on 22.10.2026 at 09:41" }],
    ["an IP address", { text: "Login code request from 192.168.10.20" }],
    ["digits in a URL", { text: "Verify at https://login.example/v/482913/confirm" }],
    ["no announcing word", { text: "Thanks for shopping. 482913 people joined this week." }],
    ["two codes with equal evidence", { text: "Code: 482913\nCode: 719204" }],
  ])("ignores %s", (_, input) => {
    expect(code(input)).toEqual(Option.none());
  });
});

describe("Verification.extract: links", () => {
  const button = (href: string, text: string) =>
    `<p>Please confirm your email address.</p><a href="${href}" class="btn">${text}</a>` +
    '<p><a href="https://mail.example/unsubscribe?u=1">Unsubscribe</a></p>';

  it("finds the confirmation button, entities decoded", () => {
    expect(
      link({ html: button("https://app.example/verify?token=abc&amp;u=7", "Confirm email") }),
    ).toEqual(Option.some("https://app.example/verify?token=abc&u=7"));
  });

  it("takes a click-tracking redirect when the button says what it does", () => {
    expect(link({ html: button("https://click.example/ls/xyz", "Verify my account") })).toEqual(
      Option.some("https://click.example/ls/xyz"),
    );
  });

  it("finds a magic link in a text body by the line above it", () => {
    expect(
      link({
        subject: "Sign in to Example",
        text: "Click the link below to sign in:\nhttps://app.example/magic?token=q1w2e3\n",
      }),
    ).toEqual(Option.some("https://app.example/magic?token=q1w2e3"));
  });

  it("ignores links in mail that isn't about signing in or confirming", () => {
    expect(
      link({ html: '<a href="https://shop.example/track/123">Track your parcel</a>' }),
    ).toEqual(Option.none());
  });

  it("never picks unsubscribe, help or account-review links", () => {
    expect(
      link({
        subject: "New sign-in to your account",
        html:
          '<a href="https://app.example/security/review">Review activity</a>' +
          '<a href="https://app.example/help">Help</a>',
      }),
    ).toEqual(Option.none());
  });

  it("ignores non-http links", () => {
    expect(link({ subject: "Confirm", html: '<a href="mailto:x@y.example">Confirm</a>' })).toEqual(
      Option.none(),
    );
  });
});

/** The corpus: synthetic mails shaped like real senders' (`verification-corpus/README.md`). */
const Manifest = Schema.Array(
  Schema.Struct({
    file: Schema.String,
    code: Schema.OptionFromNullOr(Schema.String),
    link: Schema.OptionFromNullOr(Schema.String),
    lang: Schema.String,
    notes: Schema.String,
  }),
);

const corpus = (path: string) =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    fs.readFile(new URL(`./verification-corpus/${path}`, import.meta.url).pathname),
  ).pipe(Effect.provide(NodeServices.layer));

interface Pair {
  readonly expected: Option.Option<string>;
  readonly found: Option.Option<string>;
}

const isWrong = (pair: Pair) =>
  Option.isSome(pair.found) && !Option.contains(pair.expected, pair.found.value);
const isRight = (pair: Pair) => Option.isSome(pair.found) && !isWrong(pair);

/** Share of the expected answers found, exactly. */
const recall = (pairs: ReadonlyArray<Pair>) =>
  Arr.filter(pairs, isRight).length /
  Arr.filter(pairs, (pair) => Option.isSome(pair.expected)).length;

describe("Verification.extract on the corpus", () => {
  it.effect("never answers wrong, and finds nearly everything", () =>
    Effect.gen(function* () {
      const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(
        new TextDecoder().decode(yield* corpus("manifest.json")),
      );
      const results = yield* Effect.forEach(
        manifest,
        (entry) =>
          Effect.gen(function* () {
            const content = yield* Message.read(new Uint8Array(yield* corpus(entry.file)));
            const found = Verification.extract(content);
            return {
              file: entry.file,
              code: { expected: entry.code, found: found.code },
              link: { expected: entry.link, found: found.link },
            };
          }),
        { concurrency: 8 },
      );
      expect(results.length).toBeGreaterThanOrEqual(60);
      // Precision first: a wrong code or link is never acceptable. Named, so a regression shows
      // which mail.
      expect(
        Arr.map(
          Arr.filter(results, (result) => isWrong(result.code) || isWrong(result.link)),
          (result) => result.file,
        ),
      ).toEqual([]);
      expect(recall(Arr.map(results, (result) => result.code))).toBeGreaterThanOrEqual(0.95);
      expect(recall(Arr.map(results, (result) => result.link))).toBeGreaterThanOrEqual(0.95);
    }),
  );
});
