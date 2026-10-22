import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { rules } from "../src/internal/lists/easyprivacy.ts";
import { isTrackerUrl } from "../src/internal/filters.ts";
import { Mail } from "../src/index.ts";
import { binary, bytes, split, textParts, values } from "./support/mime.ts";

/** Tracker protection on forwarded mail (PLAN.md §20.19), through `Mail.forward`. */

const block: Mail.Protection = { images: "block-trackers", isLinkCleaningEnabled: false };
const blockAndClean: Mail.Protection = { images: "block-trackers", isLinkCleaningEnabled: true };
const off: Mail.Protection = { images: "off", isLinkCleaningEnabled: false };

const forward = (raw: Uint8Array, protection: Mail.Protection) =>
  Mail.forward(raw, {
    alias: { local: "shop", domain: "alias.test" },
    sender: { name: Option.none(), address: "news@store.example" },
    token: "t0k3n",
    protection,
  });

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

const html = (body: string, ...fields: ReadonlyArray<string>) =>
  message("text/html; charset=utf-8", body, ...fields);

/** The forwarded message's only text part, decoded. */
const textOf = (out: Uint8Array) => Arr.map(textParts(out), (part) => part.text).join("\n");

const removed = (out: Uint8Array) => values(out, "X-Alias-Trackers-Removed");
const cleaned = (out: Uint8Array) => values(out, "X-Alias-Links-Cleaned");

describe("tracking images", () => {
  it.effect.each([
    ["a 1×1 pixel", '<img src="https://img.store.example/p.gif" width="1" height="1">'],
    ["a 2×2 pixel", '<img width=2 height="2px" src="https://img.store.example/p.gif">'],
    [
      "a pixel sized by CSS",
      '<img src="https://img.store.example/p" style="width:1px;height:1px">',
    ],
    ["a zero-height image", '<img src="https://img.store.example/p" width="600" height="0">'],
    ["display:none", '<img src="https://img.store.example/p" style="DISPLAY: none !important">'],
    ["visibility:hidden", "<img src='https://img.store.example/p' style='visibility:hidden'>"],
    ["opacity:0", '<img src="https://img.store.example/p" style="opacity:0">'],
    ["the hidden attribute", '<img hidden src="https://img.store.example/p">'],
    ["max-height:0", '<img src="https://img.store.example/p" style="max-height:0px">'],
    [
      "a Mailchimp open pixel",
      '<img src="https://store.us1.list-manage.com/track/open.php?u=1&amp;id=2" alt="">',
    ],
    [
      "a SendGrid open pixel",
      '<img src="http://u123.ct.sendgrid.net/wf/open?upn=abc" width="600">',
    ],
    ["SES open tracking", '<img src="https://abc.r.eu-west-1.awstrack.me/I0/0102/xyz" />'],
    ["a scheme-relative tracker", '<img src="//u1.ct.sendgrid.net/wf/open?upn=x">'],
    ["an entity-encoded tracker", '<img src="https&#58;//u1.ct.sendgrid.net/wf/open&#x3F;upn=x">'],
  ])("removes %s", ([, tag]) =>
    Effect.gen(function* () {
      const out = yield* forward(html(`<p>Hello</p>${tag}<p>Bye</p>`), block);
      expect(textOf(out)).toBe("<p>Hello</p><p>Bye</p>");
      expect(removed(out)).toEqual(["1"]);
    }),
  );

  it.effect.each([
    [
      "a visible remote image",
      '<img src="https://img.store.example/hero.jpg" width="600" height="300">',
    ],
    ["an image without a size", '<img src="https://img.store.example/logo.png" alt="Store">'],
    ["a wide divider", '<img src="https://img.store.example/line.gif" width="600" height="1">'],
    ["an inline attachment", '<img src="cid:logo@store.example" width="1" height="1">'],
    ["a data URL", '<img src="data:image/gif;base64,R0lGOD" width="1" height="1">'],
    ["a relative URL", '<img src="/p.gif" width="1" height="1">'],
    ["a link to a tracker", '<a href="https://u1.ct.sendgrid.net/wf/open?upn=x">open</a>'],
  ])("keeps %s", ([, tag]) =>
    Effect.gen(function* () {
      const raw = html(`<p>Hello</p>${tag}`);
      const out = yield* forward(raw, block);
      expect(split(out).rest).toEqual(split(raw).rest);
      expect(removed(out)).toEqual([]);
    }),
  );

  it.effect("neutralises tracker URLs in CSS and background attributes", () =>
    Effect.gen(function* () {
      const raw = html(
        [
          "<style>@media print { body { background: url('https://u1.ct.sendgrid.net/wf/open?upn=p') } }",
          ".hero { background-image: url(https://img.store.example/hero.jpg) }</style>",
          '<td background="https://x.list-manage.com/track/open.php?u=1" style="color:red;',
          ' background:url(&quot;https://x.list-manage.com/track/open.php?u=2&quot;) no-repeat">',
          '<div style="background:url(https://img.store.example/bg.png)">x</div>',
        ].join("\r\n"),
      );
      const out = yield* forward(raw, block);
      expect(textOf(out)).toBe(
        [
          "<style>@media print { body { background: none } }",
          ".hero { background-image: url(https://img.store.example/hero.jpg) }</style>",
          '<td style="color:red;',
          ' background:none no-repeat">',
          '<div style="background:url(https://img.store.example/bg.png)">x</div>',
        ].join("\r\n"),
      );
      expect(removed(out)).toEqual(["3"]);
    }),
  );

  it.effect("counts every tracker, across parts, and re-encodes only the parts that change", () =>
    Effect.gen(function* () {
      const pixel = '<img src="https://img.store.example/o.gif" width="1" height="1">';
      const raw = bytes(
        [
          "From: news@store.example",
          "MIME-Version: 1.0",
          'Content-Type: multipart/alternative; boundary="b"',
          "",
          "--b",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Plain text https://store.example/?utm_source=mail",
          "--b",
          "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: quoted-printable",
          "",
          `<p style=3D"color:red">Gr=C3=BC=C3=9Fe</p>${pixel.replace(/=/g, "=3D")}<img src=3D"htt=`,
          `ps://u1.ct.sendgrid.net/wf/open?upn=3Dx">`,
          "--b--",
          "",
        ].join("\r\n"),
      );
      const out = yield* forward(raw, block);
      expect(removed(out)).toEqual(["2"]);
      const [plain, rich] = textParts(out);
      expect(plain?.text).toBe("Plain text https://store.example/?utm_source=mail");
      expect(rich?.text).toBe('<p style="color:red">Grüße</p>');
      expect(binary(out)).toContain(
        "Content-Transfer-Encoding: quoted-printable\r\n\r\n<p style=3D",
      );
    }),
  );

  it.effect("changes nothing when protection is off", () =>
    Effect.gen(function* () {
      const raw = html('<img src="https://u1.ct.sendgrid.net/wf/open?upn=x" width="1" height="1">');
      const out = yield* forward(raw, off);
      expect(split(out).rest).toEqual(split(raw).rest);
      expect(removed(out)).toEqual([]);
    }),
  );

  it.effect("leaves UTF-16 parts alone", () =>
    Effect.gen(function* () {
      const raw = message(
        "text/html; charset=utf-16le",
        '<img src="https://u1.ct.sendgrid.net/wf/open?upn=x">',
      );
      expect(split(yield* forward(raw, block)).rest).toEqual(split(raw).rest);
    }),
  );

  it.effect("replaces incoming protection fields, and adds none when nothing changed", () =>
    Effect.gen(function* () {
      const raw = html("<p>Hi</p>", "X-Alias-Trackers-Removed: 0", "X-Alias-Links-Cleaned: 9");
      const out = yield* forward(raw, blockAndClean);
      expect(removed(out)).toEqual([]);
      expect(cleaned(out)).toEqual([]);
    }),
  );
});

describe("link cleaning", () => {
  it.effect.each([
    [
      "UTM tags and click ids, keeping the rest",
      '<a href="https://store.example/p?id=7&amp;utm_source=news&amp;utm_medium=email&amp;fbclid=x#top">',
      '<a href="https://store.example/p?id=7#top">',
    ],
    [
      "a query of tracking parameters only",
      "<a href='https://store.example/?utm_campaign=fall&mc_eid=abc'>",
      "<a href='https://store.example/'>",
    ],
    [
      "a tracking parameter before a kept one",
      '<a class="btn" href="https://store.example/?gclid=1&amp;size=m" target="_blank">',
      '<a class="btn" href="https://store.example/?size=m" target="_blank">',
    ],
    [
      "Brave's site-specific parameters on their site",
      '<a href="https://www.instagram.com/store/?igshid=abc&amp;hl=de">',
      '<a href="https://www.instagram.com/store/?hl=de">',
    ],
  ])("removes %s", ([, before, after]) =>
    Effect.gen(function* () {
      const out = yield* forward(html(`${before}Shop</a>`), blockAndClean);
      expect(textOf(out)).toBe(`${after}Shop</a>`);
      expect(cleaned(out)).toEqual(["1"]);
    }),
  );

  it.effect.each([
    ["a link without tracking parameters", '<a href="https://store.example/?id=7&amp;size=m">'],
    ["a site-specific parameter elsewhere", '<a href="https://store.example/?igshid=abc">'],
    ["a mailto link", '<a href="mailto:help@store.example?subject=utm_source">'],
    ["an image source", '<img src="https://img.store.example/hero.jpg?utm_source=x" width="600">'],
  ])("keeps %s", ([, tag]) =>
    Effect.gen(function* () {
      const raw = html(`${tag}x</a>`);
      expect(split(yield* forward(raw, blockAndClean)).rest).toEqual(split(raw).rest);
    }),
  );

  it.effect("cleans bare links in plain text", () =>
    Effect.gen(function* () {
      const out = yield* forward(
        message(
          "text/plain; charset=utf-8",
          "Shop (https://store.example/?utm_source=a&id=1) or https://store.example/x?fbclid=2.",
        ),
        blockAndClean,
      );
      expect(textOf(out)).toBe("Shop (https://store.example/?id=1) or https://store.example/x.");
      expect(cleaned(out)).toEqual(["2"]);
    }),
  );

  it.effect("is off unless asked for", () =>
    Effect.gen(function* () {
      const raw = html('<a href="https://store.example/?utm_source=a">x</a>');
      expect(split(yield* forward(raw, block)).rest).toEqual(split(raw).rest);
    }),
  );
});

describe("the vendored EasyPrivacy rules", () => {
  /** A URL each rule must match: `*` stands for some text, `^` for a separator. */
  const sample = (rule: string) =>
    new URL(
      `https://a.example/x?q=${(rule.split("$")[0] ?? "").replace(/\*/g, "x").replace(/\^/g, "/")}`,
    );

  it("are all understood, each matching a URL built from it", () => {
    expect(rules.length).toBeGreaterThan(250);
    expect(Arr.filter(rules, (rule) => !isTrackerUrl(sample(rule)))).toEqual([]);
  });

  it("match no ordinary image", () => {
    expect(isTrackerUrl(new URL("https://img.store.example/newsletter/hero.jpg"))).toBe(false);
  });
});

describe("Mail.forward on the golden corpus", () => {
  /** What must be gone from every inline text part, read with the test-side MIME decoder. */
  const cases = [
    {
      name: "forward-mailchimp",
      protection: blockAndClean,
      gone: ["list-manage.com/track/", "utm_", "mc_cid", "mc_eid=9b8c7d&"],
    },
    {
      name: "forward-sendgrid-base64",
      protection: blockAndClean,
      gone: ["/wf/open", "spacer.gif"],
    },
    { name: "forward-related-attachment", protection: block, gone: ["9f8e7d.gif"] },
    { name: "forward-latin1-qp", protection: blockAndClean, gone: ["emailtracking.", "o.gif"] },
    { name: "forward-nothing-to-protect", protection: blockAndClean, gone: [] },
  ];

  const read = (file: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.readFile(new URL(`./corpus/${file}`, import.meta.url).pathname),
    ).pipe(
      // NodeFileSystem returns a Buffer, which never deep-equals a plain Uint8Array.
      Effect.map((data) => new Uint8Array(data)),
      Effect.provide(NodeServices.layer),
    );

  const relay = (raw: Uint8Array, protection: Mail.Protection) =>
    Mail.forward(raw, {
      alias: { local: "shop", domain: "ada.alias.test" },
      sender: { name: Option.some("Store"), address: "news@store.example" },
      token: "ceaqyyzlmfuwyqdcfzswqylnobwgkc5o6ccdy2xqc",
      protection,
    });

  it.effect.each(cases)(
    "$name: matches the reviewed output byte for byte",
    ({ name, protection }) =>
      Effect.gen(function* () {
        const out = yield* relay(yield* read(`${name}.eml`), protection);
        expect(binary(out)).toBe(binary(yield* read(`${name}.expected.eml`)));
        // Forwarding the output again changes no body byte.
        expect(split(yield* relay(out, protection)).rest).toEqual(split(out).rest);
      }),
  );

  it.effect.each(cases)(
    "$name: leaves no tracker in any inline text part",
    ({ name, protection, gone }) =>
      Effect.gen(function* () {
        const out = yield* relay(yield* read(`${name}.eml`), protection);
        const inline = Arr.filter(textParts(out), (part) => !part.isAttachment);
        expect(inline.length).toBeGreaterThan(0);
        Arr.map(inline, (part) => Arr.map(gone, (text) => expect(part.text).not.toContain(text)));
      }),
  );

  it.effect("keeps attachments and inline images byte for byte", () =>
    Effect.gen(function* () {
      const raw = yield* read("forward-related-attachment.eml");
      const out = yield* relay(raw, block);
      const from = (data: Uint8Array, marker: string) =>
        binary(data).slice(binary(data).indexOf(marker));
      expect(from(out, "--related-b2\r\nContent-Type: image/gif")).toBe(
        from(raw, "--related-b2\r\nContent-Type: image/gif"),
      );
      // The attached HTML file keeps its pixel: attachments aren't touched.
      expect(binary(out)).toContain("wf/open?upn=attached");
    }),
  );
});
