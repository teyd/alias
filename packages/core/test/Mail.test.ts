import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Address, Keyring, Mail, ReverseToken } from "../src/index.ts";
import { newsletter, newsletterBody, newsletterHeaders, ownerReply } from "./support/fixtures.ts";
import { binary, bytes, mailbox, split, textParts, values } from "./support/mime.ts";

const alias: Address.MailAddress = { local: "k7m2qx9p", domain: "alias.test" };
const token = "ceaqyyzlmfuwyqdcfzswqylnobwgkc5o6ccdy2xqc";
const reverse = `k7m2qx9p+r.${token}@alias.test`;
const cafe: Mail.Sender = { name: Option.some("Café Müller"), address: "news@cafe.example" };
/** The alias owner of the `ownerReply` fixture. */
const owner: Mail.Owner = { addresses: ["jane.doe@gmail.example"], name: Option.some("Jane Doe") };

/** Tracker protection off: forwarding changes header fields only. */
const unprotected: Mail.Protection = { images: "off", isLinkCleaningEnabled: false };

const forwardWith = (raw: Uint8Array, sender: Mail.Sender = cafe) =>
  Mail.forward(raw, { alias, sender, token, protection: unprotected });

/** Right-to-left override and pop directional formatting, written out so they stay visible. */
const RLO = String.fromCodePoint(0x202e);
const PDF = String.fromCodePoint(0x202c);

const names = (data: Uint8Array) => split(data).fields.map((field) => field.name.toLowerCase());

const physicalLines = (data: Uint8Array) => split(data).headerText.split(/\r?\n/);

/** The display text of the rewritten `From`, decoded the way a mail client would. */
const fromDisplay = (sender: Mail.Sender) =>
  Effect.map(forwardWith(bytes("Subject: x\r\n\r\nbody"), sender), (out) => {
    const [from] = values(out, "From");
    return mailbox(from ?? "").display;
  });

describe("Mail.forward", () => {
  describe.each([
    ["CRLF", "\r\n"],
    ["LF", "\n"],
  ])("with %s line endings", (_, eol) => {
    it.effect("sets From and Reply-To to the reverse alias with the sender in the name", () =>
      Effect.gen(function* () {
        const out = yield* forwardWith(newsletter(eol));
        const from = values(out, "From");
        const replyTo = values(out, "Reply-To");
        expect(from).toHaveLength(1);
        expect(replyTo).toEqual(from);
        expect(mailbox(from[0] ?? "")).toEqual({
          display: "Café Müller (news@cafe.example)",
          address: reverse,
        });
      }),
    );

    it.effect("removes signatures, verdicts, bounce and receipt addresses", () =>
      Effect.gen(function* () {
        const out = yield* forwardWith(newsletter(eol));
        expect(names(out)).toEqual([
          "from",
          "reply-to",
          "x-alias-forwarded",
          "received",
          "to",
          "subject",
          "date",
          "message-id",
          "list-unsubscribe",
          "list-unsubscribe-post",
          "mime-version",
          "content-type",
        ]);
        // No orphaned continuation lines from the folded signatures.
        expect(binary(out)).not.toMatch(/dGhlIG9yaWdpbmFs|bh=47DEQ|cv=none/);
      }),
    );

    it.effect("keeps the subject, the other fields and every body byte as they were", () =>
      Effect.gen(function* () {
        const raw = newsletter(eol);
        const out = yield* forwardWith(raw);
        expect(split(out).rest).toEqual(newsletterBody(eol));
        expect(split(out).rest).toEqual(split(raw).rest);
        const subject = `Subject: =?UTF-8?B?8J+NsCBEaWUgS3VjaGVuLVdvY2hl?= ist da:${eol} neue Rezepte und =?ISO-8859-1?Q?=C4pfel?=${eol}`;
        expect(binary(out)).toContain(subject);
        const received = newsletterHeaders(eol).split(eol).slice(1, 4).join(eol);
        expect(binary(out)).toContain(received);
      }),
    );

    it.effect("writes new fields with the message's own line ending", () =>
      Effect.gen(function* () {
        const out = yield* forwardWith(newsletter(eol));
        const head = split(out).headerText;
        expect(eol === "\n" ? head.includes("\r") : /[^\r]\n/.test(head)).toBe(false);
      }),
    );

    it.effect("marks the copy with the alias, keeping other aliases' marks", () =>
      Effect.gen(function* () {
        const raw = bytes(
          ["X-Alias-Forwarded: other@alias.test", "Subject: x", "", "body"].join(eol),
        );
        const out = yield* forwardWith(raw);
        expect(values(out, "X-Alias-Forwarded")).toEqual([
          "k7m2qx9p@alias.test",
          "other@alias.test",
        ]);
      }),
    );

    it.effect("is idempotent: forwarding the output again changes nothing", () =>
      Effect.gen(function* () {
        const once = yield* forwardWith(newsletter(eol));
        expect(yield* forwardWith(once)).toEqual(once);
      }),
    );
  });

  it.effect("keeps raw 8-bit header values (RFC 6532) byte for byte", () =>
    Effect.gen(function* () {
      const raw = Uint8Array.from([
        ...bytes("From: a@b.example\r\nSubject: Grüße "),
        0xff,
        0xfe,
        ...bytes("\r\n\r\n"),
        0xe9,
      ]);
      const out = yield* forwardWith(raw);
      expect(binary(out)).toContain(binary(raw.subarray(19, raw.length)));
    }),
  );

  it.effect("accepts a message with no body and no blank line", () =>
    Effect.gen(function* () {
      const out = yield* forwardWith(bytes("From: a@b.example\r\nSubject: hi"));
      expect(names(out)).toEqual(["from", "reply-to", "x-alias-forwarded", "subject"]);
      expect(binary(out).endsWith("\r\nSubject: hi")).toBe(true);
    }),
  );

  it.effect("handles huge header blocks in linear time", () =>
    Effect.gen(function* () {
      const received = Array.from(
        { length: 20_000 },
        (_, i) =>
          `Received: from hop${i}.relay.example by hop${i + 1}.relay.example;\r\n Tue, 21 Oct 2026 09:14:02 +0000`,
      );
      const references = `References:${Array.from({ length: 5_000 }, (_, i) => ` <${i}.thread@lists.example>`).join("\r\n")}`;
      const raw = bytes(
        [
          ...received,
          references,
          "DKIM-Signature: v=1;\r\n b=x",
          "From: a@b.example",
          "",
          "body",
        ].join("\r\n"),
      );
      const out = yield* forwardWith(raw);
      expect(values(out, "Received")).toHaveLength(20_000);
      expect(values(out, "DKIM-Signature")).toHaveLength(0);
      expect(binary(out)).toContain(references);
      expect(binary(out).endsWith("\r\n\r\nbody")).toBe(true);
    }),
  );

  it.effect("rejects input that is not a message", () =>
    Effect.gen(function* () {
      const reason = (raw: string) =>
        Effect.map(Effect.flip(forwardWith(bytes(raw))), (error) => error.reason);
      expect(yield* reason("")).toBe("no header fields");
      expect(yield* reason("\r\nbody")).toBe("no header fields");
      expect(yield* reason(" continued: x\r\n\r\n")).toBe("no header fields");
      // An mbox separator left in front of the message.
      expect(yield* reason("From sender@x Tue Oct 21 09:14:02 2026\r\nSubject: x\r\n\r\n")).toBe(
        "header line without a field name",
      );
    }),
  );

  describe("display names", () => {
    it.effect("quotes short ASCII names and escapes quotes and backslashes", () =>
      Effect.gen(function* () {
        const out = yield* forwardWith(bytes("Subject: x\r\n\r\n"), {
          name: Option.some('Acme "Support" \\ Team'),
          address: "help@acme.example",
        });
        expect(binary(out)).toContain(
          `From: "Acme \\"Support\\" \\\\ Team (help@acme.example)"\r\n <${reverse}>\r\n`,
        );
      }),
    );

    it.effect.each([
      ["no name", Option.none<string>(), "help@acme.example"],
      ["an empty name", Option.some("  "), "help@acme.example"],
      ["the address as name", Option.some("Help@Acme.example"), "help@acme.example"],
      [
        "CJK",
        Option.some("株式会社 ハローワールド"),
        "株式会社 ハローワールド (help@acme.example)",
      ],
      ["emoji", Option.some("👩‍👩‍👧 Family Shop"), "👩‍👩‍👧 Family Shop (help@acme.example)"],
      [
        "an encoded-word lookalike",
        Option.some("=?UTF-8?B?SGk=?="),
        "=?UTF-8?B?SGk=?= (help@acme.example)",
      ],
      [
        "header injection",
        Option.some("Evil\r\nBcc: victim@x.example"),
        "Evil Bcc: victim@x.example (help@acme.example)",
      ],
      [
        "bidi overrides",
        Option.some(`Bank${RLO} moc.evil${PDF}`),
        "Bank moc.evil (help@acme.example)",
      ],
    ] satisfies ReadonlyArray<readonly [string, Option.Option<string>, string]>)(
      "handles %s",
      ([, name, expected]) =>
        Effect.gen(function* () {
          expect(yield* fromDisplay({ name, address: "help@acme.example" })).toBe(expected);
        }),
    );

    it.effect("encodes long names as several words on lines of at most 78 characters", () =>
      Effect.gen(function* () {
        const name = "Ünïcödé ".repeat(12).trim();
        const out = yield* forwardWith(bytes("Subject: x\r\n\r\n"), {
          name: Option.some(name),
          address: "news@cafe.example",
        });
        const lines = physicalLines(out);
        const fromLines = lines.slice(
          0,
          lines.findIndex((line) => line.startsWith("Reply-To:")),
        );
        expect(fromLines.length).toBeGreaterThan(2);
        expect(lines.every((line) => line.length <= 78)).toBe(true);
        expect(
          binary(out)
            .match(/=\?UTF-8\?B\?[^?]*\?=/g)
            ?.every((word) => word.length <= 75),
        ).toBe(true);
        expect(mailbox(values(out, "From")[0] ?? "").display).toBe(`${name} (news@cafe.example)`);
      }),
    );

    it.effect("caps absurdly long names", () =>
      Effect.gen(function* () {
        const display = yield* fromDisplay({
          name: Option.some("x".repeat(5000)),
          address: "a@b.example",
        });
        expect(display).toBe(`${"x".repeat(127)}… (a@b.example)`);
      }),
    );

    it.effect.prop(
      "any name decodes back to its one-line, control-free form",
      [
        Arbitrary.map(Arbitrary.schema(Schema.String.check(Schema.isMaxLength(100))), (text) =>
          text.replace(/\p{Surrogate}/gu, ""),
        ),
      ],
      ([name]) =>
        Effect.gen(function* () {
          const display = yield* fromDisplay({ name: Option.some(name), address: "a@b.example" });
          const shown = name
            .replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ")
            .replace(/\s+/gu, " ")
            .trim();
          expect(display).toBe(
            shown === "" || shown.toLowerCase() === "a@b.example"
              ? "a@b.example"
              : `${shown} (a@b.example)`,
          );
        }),
    );
  });

  it.effect.prop("never changes a body byte", [Arbitrary.schema(Schema.Uint8Array)], ([body]) =>
    Effect.gen(function* () {
      const raw = Uint8Array.from([
        ...bytes("From: a@b.example\r\nDKIM-Signature: x\r\n\r\n"),
        ...body,
      ]);
      const out = yield* forwardWith(raw);
      expect(out.subarray(out.length - body.length - 2)).toEqual(
        Uint8Array.from([0x0d, 0x0a, ...body]),
      );
    }),
  );
});

describe("Mail.reply", () => {
  const contact = "news@cafe.example";
  const messageId = "5b0c7a2e-1f7d-4c33-9d1e-0e9b8c1f2a44";

  it.effect("sends as the alias, to the contact, without identifying fields", () =>
    Effect.gen(function* () {
      const out = yield* Mail.reply(ownerReply("\r\n", reverse), {
        alias,
        to: contact,
        messageId,
        owner,
      });
      expect(names(out)).toEqual([
        "from",
        "to",
        "message-id",
        "cc",
        "subject",
        "in-reply-to",
        "references",
        "date",
        "mime-version",
        "content-type",
        "content-transfer-encoding",
      ]);
      expect(values(out, "From")).toEqual(["k7m2qx9p@alias.test"]);
      expect(values(out, "To")).toEqual([contact]);
      expect(values(out, "Message-ID")).toEqual([`<${messageId}@alias.test>`]);
      expect(binary(out)).not.toMatch(/198\.51\.100\.23|Thunderbird|Apple Mail|jane\.doe|gmail/);
    }),
  );

  it.effect("drops the forward marker, which names the alias", () =>
    Effect.gen(function* () {
      const forwarded = yield* forwardWith(newsletter("\r\n"));
      const raw = Uint8Array.from([
        ...bytes(`X-Alias-Forwarded: ${Address.format(alias)}\r\n`),
        ...ownerReply("\r\n", reverse),
      ]);
      expect(values(forwarded, "X-Alias-Forwarded")).toEqual(["k7m2qx9p@alias.test"]);
      const out = yield* Mail.reply(raw, { alias, to: contact, messageId, owner });
      expect(values(out, "X-Alias-Forwarded")).toEqual([]);
    }),
  );

  const replyWith = (headers: ReadonlyArray<string>, body: Uint8Array) =>
    Mail.reply(Uint8Array.from([...bytes([...headers, "", ""].join("\r\n")), ...body]), {
      alias,
      to: contact,
      messageId,
      owner,
    }).pipe(Effect.map((out) => split(out).rest));

  it.effect("leaves longer addresses, other words and unquoted names alone", () =>
    Effect.gen(function* () {
      const body = bytes(
        [
          "Jane Doe here, my old mail was xjane.doe@gmail.example, see jane.doe@gmail.example.org",
          "> Jane Doerte and Jane Does wrote nothing of note",
          "",
        ].join("\r\n"),
      );
      expect(yield* replyWith(["Content-Type: text/plain"], body)).toEqual(
        Uint8Array.from([...bytes("\r\n"), ...body]),
      );
    }),
  );

  it.effect("finds an address that quoted-printable split across a soft line break", () =>
    Effect.gen(function* () {
      const out = yield* replyWith(
        ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable"],
        bytes("> Write to jane.do=\r\ne@gmail.example =C3=BC\r\n"),
      );
      expect(binary(out)).toBe("\r\n> Write to k7m2qx9p@alias.test =C3=BC\r\n");
    }),
  );

  it.effect("leaves UTF-16 parts and unknown transfer encodings alone", () =>
    Effect.gen(function* () {
      const utf16 = Uint8Array.from(
        Array.from("jane.doe@gmail.example", (char) => [char.charCodeAt(0), 0]).flat(),
      );
      expect(yield* replyWith(["Content-Type: text/plain; charset=utf-16le"], utf16)).toEqual(
        Uint8Array.from([0x0d, 0x0a, ...utf16]),
      );
      const uuencoded = bytes("jane.doe@gmail.example");
      expect(
        yield* replyWith(
          ["Content-Type: text/plain", "Content-Transfer-Encoding: x-uuencode"],
          uuencoded,
        ),
      ).toEqual(Uint8Array.from([0x0d, 0x0a, ...uuencoded]));
    }),
  );

  it.effect("keeps the body and the threading fields byte for byte", () =>
    Effect.gen(function* () {
      const raw = ownerReply("\n", reverse);
      const out = yield* Mail.reply(raw, { alias, to: contact, messageId, owner });
      expect(split(out).rest).toEqual(split(raw).rest);
      expect(binary(out)).toContain("In-Reply-To: <20261021091400.4f2a@cafe.example>\nReferences:");
      expect(binary(out)).not.toContain("\r");
    }),
  );
});

layer(NodeCrypto.layer)((it) => {
  it.effect("forward and reply round-trip through a real reverse token", () =>
    Effect.gen(function* () {
      const keys = yield* Keyring.make({
        current: { version: 1, secret: Redacted.make(new Uint8Array(32).fill(3)) },
        retired: [],
      });
      const minted = yield* ReverseToken.mint(keys, alias, {
        sender: Option.some(cafe.address),
        contactId: Option.none(),
      });
      const forwarded = yield* Mail.forward(newsletter("\r\n"), {
        alias,
        sender: cafe,
        token: minted,
        protection: unprotected,
      });

      // The owner's client replies to the Reply-To address; the inbound side parses it back.
      const replyTo = mailbox(values(forwarded, "Reply-To")[0] ?? "").address;
      const recipient = yield* Address.parse(replyTo);
      const parts = yield* Effect.fromOption(Address.reverseToken(recipient));
      const aliasAddress = { local: parts.aliasLocal, domain: recipient.domain };
      const claims = yield* ReverseToken.verify(keys, aliasAddress, parts.token);
      const to = yield* Effect.fromOption(claims.sender);

      const sent = yield* Mail.reply(ownerReply("\r\n", replyTo), {
        alias: aliasAddress,
        to,
        messageId: "reply-1",
        owner,
      });
      expect(values(sent, "From")).toEqual(["k7m2qx9p@alias.test"]);
      expect(values(sent, "To")).toEqual(["news@cafe.example"]);
    }),
  );
});

describe("Mail.reply on the golden corpus", () => {
  const ada: Mail.Owner = {
    addresses: ["ada@mailbox.example", "ada.work@office.example"],
    name: Option.some("Ada Lovelace"),
  };
  const zoe: Mail.Owner = { addresses: ["zoe@mailbox.example"], name: Option.some("Zoë Müller") };
  const cases = [
    { name: "gmail-alternative", owner: ada },
    { name: "apple-mail", owner: ada },
    { name: "thunderbird-flowed", owner: ada },
    { name: "outlook-base64", owner: ada },
    { name: "latin1-qp", owner: zoe },
    { name: "attachment-mixed", owner: ada },
    { name: "nothing-to-scrub", owner: ada },
  ];

  const read = (file: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.readFile(new URL(`./corpus/${file}`, import.meta.url).pathname),
    ).pipe(
      // NodeFileSystem returns a Buffer, which never deep-equals a plain Uint8Array.
      Effect.map((data) => new Uint8Array(data)),
      Effect.provide(NodeServices.layer),
    );

  const relay = (raw: Uint8Array, owner: Mail.Owner) =>
    Mail.reply(raw, {
      alias: { local: "shop", domain: "ada.alias.test" },
      to: "orders@store.example",
      messageId: "reply-1",
      owner,
    });

  it.effect.each(cases)("$name: matches the reviewed output byte for byte", ({ name, owner }) =>
    Effect.gen(function* () {
      const out = yield* relay(yield* read(`${name}.eml`), owner);
      expect(binary(out)).toBe(binary(yield* read(`${name}.expected.eml`)));
      // Relaying the output again changes nothing.
      expect(binary(yield* relay(out, owner))).toBe(binary(out));
    }),
  );

  it.effect.each(cases)(
    "$name: leaves no owner address in any inline text part",
    ({ name, owner }) =>
      Effect.gen(function* () {
        const out = yield* relay(yield* read(`${name}.eml`), owner);
        const inline = Arr.filter(textParts(out), (part) => !part.isAttachment);
        expect(inline.length).toBeGreaterThan(0);
        Arr.map(inline, (part) =>
          Arr.map(owner.addresses, (address) =>
            expect(part.text.toLowerCase()).not.toContain(address),
          ),
        );
      }),
  );

  it.effect("keeps attachments and bodies without owner data byte for byte", () =>
    Effect.gen(function* () {
      const mixed = yield* read("attachment-mixed.eml");
      const mixedOut = yield* relay(mixed, ada);
      const attachments = (raw: Uint8Array) => {
        const text = binary(raw);
        return text.slice(text.indexOf("--mixed-7c1e\r\nContent-Type: application/pdf"));
      };
      expect(attachments(mixedOut)).toBe(attachments(mixed));
      expect(binary(mixedOut)).toContain("Notes for ada@mailbox.example");

      const plain = yield* read("nothing-to-scrub.eml");
      expect(split(yield* relay(plain, ada)).rest).toEqual(split(plain).rest);
    }),
  );
});

describe("Mail.signals", () => {
  const signalsOf = (...fields: ReadonlyArray<string>) =>
    Mail.signals(bytes([...fields, "", "body"].join("\r\n")));

  it.effect("reads nothing special from a person's mail", () =>
    Effect.gen(function* () {
      expect(yield* Mail.signals(ownerReply("\r\n", reverse))).toEqual({
        forwardedBy: [],
        hops: 2,
        isAutomated: false,
        isReport: false,
      });
    }),
  );

  it.effect("counts Received hops and lists the aliases that forwarded the message", () =>
    Effect.gen(function* () {
      const forwarded = yield* forwardWith(newsletter("\n"));
      expect(yield* Mail.signals(forwarded)).toMatchObject({
        forwardedBy: ["k7m2qx9p@alias.test"],
        hops: 1,
      });
      expect(
        yield* signalsOf(
          "X-Alias-Forwarded: Shop@Alias.test",
          "x-alias-forwarded:\r\n b@alias.test",
        ),
      ).toMatchObject({ forwardedBy: ["shop@alias.test", "b@alias.test"] });
    }),
  );

  it.effect.each([
    ["Auto-Submitted: auto-replied", true],
    ["Auto-Submitted: Auto-Generated; owner-email=x@y.example", true],
    ["Auto-Submitted: auto-notified (sieve)", true],
    ["Auto-Submitted: no", false],
    ["Auto-Submitted: No (a person wrote this)", false],
    ["Precedence: bulk", true],
    ["Precedence: Junk", true],
    ["precedence:\r\n list", true],
    ["Precedence: first-class", false],
    ["X-Auto-Response-Suppress: All", false],
  ] as const)("reads %j as automated: %s", ([field, isAutomated]) =>
    Effect.gen(function* () {
      expect((yield* signalsOf("From: a@b.example", field)).isAutomated).toBe(isAutomated);
    }),
  );

  it.effect("recognises delivery and disposition reports", () =>
    Effect.gen(function* () {
      const report = yield* signalsOf(
        'Content-Type: multipart/report; report-type=delivery-status;\r\n boundary="b"',
      );
      expect(report.isReport).toBe(true);
      expect((yield* signalsOf("Content-Type: multipart/mixed")).isReport).toBe(false);
    }),
  );
});

describe("Mail.parseSender", () => {
  it.each([
    ['"Café Müller" <news@cafe.example>', Option.some("Café Müller"), "news@cafe.example"],
    ["Jane Doe <Jane@Example.com>", Option.some("Jane Doe"), "Jane@Example.com"],
    ['"Doe, \\"JD\\" Jane" <jd@example.com>', Option.some('Doe, "JD" Jane'), "jd@example.com"],
    [
      "=?UTF-8?Q?Caf=C3=A9_M=C3=BCller?= <news@cafe.example>",
      Option.some("Café Müller"),
      "news@cafe.example",
    ],
    [
      "=?UTF-8?B?8J+NsA==?= =?ISO-8859-1?Q?=C4pfel?= <a@b.example>",
      Option.some("🍰Äpfel"),
      "a@b.example",
    ],
    ["=?x-unknown?Q?abc?= <a@b.example>", Option.some("=?x-unknown?Q?abc?="), "a@b.example"],
    ["<bounce@b.example>", Option.none(), "bounce@b.example"],
    ["plain@b.example", Option.none(), "plain@b.example"],
    ["plain@b.example (Old Style)", Option.some("Old Style"), "plain@b.example"],
  ])("reads %j", (value, name, address) => {
    expect(Mail.parseSender(value)).toEqual(Option.some({ name, address }));
  });

  it.each(["", "undisclosed-recipients:;", "Jane Doe", "<not an address>"])(
    "finds no sender in %j",
    (value) => {
      expect(Mail.parseSender(value)).toEqual(Option.none());
    },
  );
});
