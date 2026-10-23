import bounceRecord from "@alias/aws/fixtures/ses-event-bounce.json" with { type: "json" };
import { describe, expect, it } from "@effect/vitest";
import * as Bounces from "../src/Bounces.ts";

type Row = readonly [
  type: "Permanent" | "Transient" | "Undetermined",
  subType: string,
  dsn: { readonly status?: string; readonly diagnosticCode?: string },
  verdict: Bounces.Verdict["_tag"],
];

/**
 * The decision table of PLAN.md §20.28, row by row. Subtypes are the ones SES documents
 * (event-publishing-retrieving-sns-contents.html, "Bounce types"); codes are RFC 3463's.
 */
const rows: ReadonlyArray<Row> = [
  // Not final, or SES can't tell: never about the address.
  [
    "Transient",
    "General",
    { status: "4.4.7", diagnosticCode: "smtp; 421 4.4.7 Delivery time expired" },
    "MessageOnly",
  ],
  [
    "Transient",
    "MailboxFull",
    { status: "5.2.2", diagnosticCode: "smtp; 552 5.2.2 Mailbox full" },
    "MessageOnly",
  ],
  [
    "Transient",
    "ContentRejected",
    { status: "5.7.1", diagnosticCode: "smtp; 554 5.7.1 Content rejected" },
    "MessageOnly",
  ],
  ["Transient", "AttachmentRejected", { status: "5.7.1" }, "MessageOnly"],
  ["Transient", "MessageTooLarge", { status: "5.3.4" }, "MessageOnly"],
  ["Undetermined", "Undetermined", {}, "MessageOnly"],
  // SES didn't send: the address is on a suppression list.
  ["Permanent", "Suppressed", { status: "5.1.1" }, "Suppressed"],
  ["Permanent", "OnAccountSuppressionList", {}, "Suppressed"],
  // The mailbox or its domain is gone, unambiguously.
  [
    "Permanent",
    "General",
    { status: "5.1.1", diagnosticCode: "smtp; 550 5.1.1 user unknown" },
    "AddressUnknown",
  ],
  ["Permanent", "NoEmail", { status: "5.1.1" }, "AddressUnknown"],
  [
    "Permanent",
    "General",
    { status: "5.1.10", diagnosticCode: "smtp; 556 5.1.10 Recipient has null MX" },
    "AddressUnknown",
  ],
  [
    "Permanent",
    "General",
    { diagnosticCode: "smtp; 550 5.1.1 <x@example.com>: user unknown" },
    "AddressUnknown",
  ],
  // Content, size or policy: about this one message.
  [
    "Permanent",
    "General",
    { status: "5.7.1", diagnosticCode: "smtp; 550 5.7.1 Message rejected as spam" },
    "MessageOnly",
  ],
  [
    "Permanent",
    "General",
    { status: "5.7.26", diagnosticCode: "smtp; 550 5.7.26 DMARC policy" },
    "MessageOnly",
  ],
  ["Permanent", "General", { status: "5.6.0" }, "MessageOnly"],
  [
    "Permanent",
    "General",
    { status: "5.3.4", diagnosticCode: "smtp; 552 5.3.4 Message too big" },
    "MessageOnly",
  ],
  ["Permanent", "General", { status: "5.2.2" }, "MessageOnly"],
  ["Permanent", "General", { status: "5.2.3" }, "MessageOnly"],
  ["Permanent", "NoEmail", { status: "5.7.1" }, "MessageOnly"],
  // A content code in the server's reply wins over an address code in `status`.
  [
    "Permanent",
    "General",
    { status: "5.1.1", diagnosticCode: "smtp; 550 5.7.1 Blocked for spam" },
    "MessageOnly",
  ],
  // Hard, but unclear: counted.
  [
    "Permanent",
    "General",
    { status: "5.0.0", diagnosticCode: "smtp; 550 Mailbox unavailable" },
    "AddressSuspect",
  ],
  ["Permanent", "General", {}, "AddressSuspect"],
  [
    "Permanent",
    "General",
    { status: "5.1.2", diagnosticCode: "smtp; 550 5.1.2 Bad destination system" },
    "AddressSuspect",
  ],
  [
    "Permanent",
    "General",
    { status: "5.2.1", diagnosticCode: "smtp; 550 5.2.1 Account disabled" },
    "AddressSuspect",
  ],
  ["Permanent", "General", { status: "5.4.4" }, "AddressSuspect"],
  [
    "Permanent",
    "General",
    { status: "5.5.0", diagnosticCode: "smtp; 550 5.5.0 Mailbox unavailable" },
    "AddressSuspect",
  ],
  [
    "Permanent",
    "NoEmail",
    { status: "5.1.1", diagnosticCode: "smtp; 550 5.4.1 Recipient address rejected" },
    "AddressSuspect",
  ],
  // A 4.x.x code is no proof the mailbox is gone.
  ["Permanent", "General", { status: "4.1.1" }, "AddressSuspect"],
  // Subtypes SES documents for features we don't use, or ones it may add: about this message.
  ["Permanent", "EmailValidationSuppressed", {}, "MessageOnly"],
  ["Permanent", "OnTenantSuppressionList", {}, "MessageOnly"],
  ["Permanent", "UnsupportedContent", { status: "5.6.1" }, "MessageOnly"],
];

describe("Bounces.classify (decision table)", () => {
  it.each(rows)("%s / %s, DSN %o → %s", (type, subType, dsn, verdict) => {
    const recipient = { emailAddress: "ada@mail.example", ...dsn };
    expect(Bounces.classify({ bounceType: type, bounceSubType: subType }, recipient)._tag).toBe(
      verdict,
    );
  });

  it("reads AWS's documented bounce record as a mailbox that doesn't exist", () => {
    const [recipient] = bounceRecord.bounce.bouncedRecipients;
    expect(
      Bounces.classify(
        { bounceType: "Permanent", bounceSubType: bounceRecord.bounce.bounceSubType },
        recipient ?? { emailAddress: "" },
      ),
    ).toEqual({ _tag: "AddressUnknown" });
  });
});
