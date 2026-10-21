import event from "@alias/aws/fixtures/ses-lambda-event.json" with { type: "json" };
import { describe, expect, it } from "@effect/vitest";
import { commonHeaders, parseHeaders } from "../src/index.ts";

describe("parseHeaders", () => {
  it("unfolds continuation lines and keeps names, order and the body out", () => {
    const raw = "From: a@x.test\r\nSubject: one\r\n two\r\nX-Empty:\r\n\r\nBody: not a header\r\n";
    expect(parseHeaders(raw)).toEqual([
      { name: "From", value: "a@x.test" },
      { name: "Subject", value: "one two" },
      { name: "X-Empty", value: "" },
    ]);
  });
});

describe("commonHeaders (contract: AWS documentation payload)", () => {
  it("derives the documented commonHeaders from the documented headers", () => {
    const mail = event.Records[0]?.ses.mail;
    const derived = commonHeaders(mail?.headers ?? [], mail?.commonHeaders.returnPath ?? "");
    // The AWS sample's Message-ID header and commonHeaders.messageId disagree, so compare the rest.
    const { messageId: _derivedId, ...derivedRest } = derived;
    const { messageId: _documentedId, ...documentedRest } = mail?.commonHeaders ?? {};
    expect(derivedRest).toEqual(documentedRest);
  });
});
