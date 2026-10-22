import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { Mail } from "../src/index.ts";

const compose = (subject: string, text: string) =>
  new TextDecoder().decode(
    Mail.compose({
      alias: { local: "shop", domain: "ada.alias.test" },
      to: "Grace@Store.example",
      subject,
      text,
      messageId: "f3a1-9c",
      date: DateTime.makeUnsafe("2026-10-22T09:30:00Z"),
    }),
  );

/** The header block and the decoded body, split the way a mail client does. */
const parse = (raw: string) => {
  const [head = "", body = ""] = raw.split("\r\n\r\n");
  return {
    headers: head.replace(/\r\n /g, " ").split("\r\n"),
    text: Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"),
    lines: raw.split("\r\n"),
  };
};

describe("Mail.compose", () => {
  it("writes a plain-text message from the alias with a fresh Message-ID on its domain", () => {
    const message = parse(compose("Your order", "Hello Grace,\nthanks!\n"));
    expect(message.headers).toEqual([
      "From: shop@ada.alias.test",
      "To: Grace@Store.example",
      "Subject: Your order",
      "Date: Thu, 22 Oct 2026 09:30:00 GMT",
      "Message-ID: <f3a1-9c@ada.alias.test>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ]);
    expect(message.text).toBe("Hello Grace,\r\nthanks!\r\n");
  });

  it("keeps a hostile subject on its own line and the body inside base64", () => {
    const raw = compose(
      "Hi\r\nBcc: everyone@evil.example\r\n\r\nInjected body",
      "line\r\n.\r\nBcc: x@evil.example\n\nFrom: ceo@bank.example",
    );
    const message = parse(raw);
    expect(message.headers.filter((line) => line.startsWith("Bcc"))).toEqual([]);
    expect(message.headers).toContain("Subject: Hi Bcc: everyone@evil.example Injected body");
    expect(message.headers.filter((line) => line.startsWith("From:"))).toEqual([
      "From: shop@ada.alias.test",
    ]);
    expect(message.text).toBe("line\r\n.\r\nBcc: x@evil.example\r\n\r\nFrom: ceo@bank.example");
    expect(message.lines.every((line) => line.length <= 78)).toBe(true);
  });

  it("encodes a non-ASCII subject as UTF-8 encoded-words, folded", () => {
    const subject = "Grüße aus Zürich – Bestellung №42 ist unterwegs, schöne Woche!";
    const message = parse(compose(subject, "Bis bald 👋"));
    const field = message.headers.find((line) => line.startsWith("Subject:")) ?? "";
    const words = field.slice("Subject: ".length).split(" ");
    expect(words.every((word) => /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(word))).toBe(true);
    expect(
      words.map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join(""),
    ).toBe(subject);
    expect(message.text).toBe("Bis bald 👋");
    expect(message.lines.every((line) => line.length <= 78)).toBe(true);
  });
});
