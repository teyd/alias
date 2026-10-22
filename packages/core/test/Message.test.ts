import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Message } from "../src/index.ts";
import { bytes } from "./support/mime.ts";

const crlf = (lines: ReadonlyArray<string>) => bytes(lines.join("\r\n"));

describe("Message.read", () => {
  it.effect("reads the headers a reader sees, encoded-words and 8-bit UTF-8 decoded", () =>
    Effect.gen(function* () {
      const content = yield* Message.read(
        crlf([
          "From: =?UTF-8?Q?Caf=C3=A9_M=C3=BCller?= <news@cafe.example>",
          "To: k7m2qx9pzr@tmp.example",
          "Subject: =?UTF-8?B?RGVpbiBDb2RlOiA0ODI5MTM=?=",
          "  und mehr",
          "Date: Thu, 22 Oct 2026 09:41:00 +0000",
          "X-Note: Grüße",
          "",
          "Hallo",
        ]),
      );
      expect(content.from).toEqual(Option.some("Café Müller <news@cafe.example>"));
      expect(content.to).toEqual(Option.some("k7m2qx9pzr@tmp.example"));
      expect(content.subject).toEqual(Option.some("Dein Code: 482913 und mehr"));
      expect(content.date).toEqual(Option.some("Thu, 22 Oct 2026 09:41:00 +0000"));
      expect(content.text).toEqual(Option.some("Hallo"));
      expect(content.html).toEqual(Option.none());
      expect(content.attachments).toEqual([]);
    }),
  );

  it.effect("a message without Content-Type is plain text (RFC 2045 §5.2)", () =>
    Effect.gen(function* () {
      const content = yield* Message.read(bytes("Subject: x\n\nline one\nline two\n"));
      expect(content.text).toEqual(Option.some("line one\nline two\n"));
    }),
  );

  it.effect("takes the first inline text and HTML parts and lists everything else", () =>
    Effect.gen(function* () {
      const content = yield* Message.read(
        crlf([
          "Subject: Your receipt",
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="outer"',
          "",
          "preamble",
          "--outer",
          'Content-Type: multipart/alternative; boundary="inner"',
          "",
          "--inner",
          "Content-Type: text/plain; charset=iso-8859-1",
          "Content-Transfer-Encoding: quoted-printable",
          "",
          "Gr=FC=DFe aus K=F6ln=",
          "",
          "--inner",
          "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          "PHA+R3LDvMOfZTwvcD4=",
          "--inner--",
          "--outer",
          'Content-Type: application/pdf; name="receipt.pdf"',
          'Content-Disposition: attachment; filename="receipt.pdf"',
          "Content-Transfer-Encoding: base64",
          "",
          "JVBERi0xLjQK",
          "--outer",
          "Content-Type: text/plain; charset=utf-8",
          "Content-Disposition: attachment; filename*=utf-8''Notiz%20%C3%BCber.txt",
          "",
          "notes",
          "--outer--",
          "",
        ]),
      );
      expect(content.text).toEqual(Option.some("Grüße aus Köln"));
      expect(content.html).toEqual(Option.some("<p>Grüße</p>"));
      expect(content.attachments).toEqual([
        { filename: Option.some("receipt.pdf"), contentType: "application/pdf", size: 9 },
        { filename: Option.some("Notiz über.txt"), contentType: "text/plain", size: 5 },
      ]);
    }),
  );

  it.effect("falls back to windows-1252 for broken UTF-8 and unknown charsets", () =>
    Effect.gen(function* () {
      const latin = new Uint8Array([
        ...bytes("Content-Type: text/plain; charset=utf-8\r\n\r\n"),
        0x66,
        0xfc,
        0x72,
      ]);
      expect((yield* Message.read(latin)).text).toEqual(Option.some("für"));
      const unknown = bytes("Content-Type: text/plain; charset=x-made-up\r\n\r\nplain");
      expect((yield* Message.read(unknown)).text).toEqual(Option.some("plain"));
    }),
  );

  it.effect("fails on bytes that are not a message", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Message.read(bytes("\r\nno header")));
      expect(error._tag).toBe("MalformedMessage");
    }),
  );
});

describe("Message.preview", () => {
  const content = (text?: string, html?: string): Message.Content => ({
    subject: Option.none(),
    from: Option.none(),
    to: Option.none(),
    date: Option.none(),
    text: Option.fromUndefinedOr(text),
    html: Option.fromUndefinedOr(html),
    attachments: [],
  });

  it("reads the text body on one line, else the HTML as text", () => {
    expect(Message.preview(content("Hello\r\n\r\n  there"))).toBe("Hello there");
    expect(Message.preview(content(undefined, "<p>Hi&nbsp;you</p><style>p{}</style>"))).toBe(
      "Hi you",
    );
    expect(Message.preview(content())).toBe("");
  });

  it("cuts long text with an ellipsis", () => {
    const out = Message.preview(content("word ".repeat(100)));
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith("word…")).toBe(true);
  });
});
