import type { SendingEvent } from "@alias/aws";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * What one bounced recipient of one of our messages means for the address (PLAN.md §20.28).
 * Only SES's documented fields decide: `bounceType`/`bounceSubType` (SES's classification) and the
 * DSN's `status` and `diagnosticCode` (what the receiving server said, as enhanced status codes,
 * RFC 3463). A sender controls a message's content, so a rejection of the content must never
 * stop forwarding to the owner; only the address being gone may.
 *
 * | SES type / subtype                                | Enhanced codes (status + diagnostic) | Verdict          |
 * | ------------------------------------------------- | ------------------------------------ | ---------------- |
 * | `Transient` / any, `Undetermined`                  | any                                  | `MessageOnly`    |
 * | `Permanent` / `Suppressed`, `OnAccountSuppressionList` | any                              | `Suppressed`     |
 * | `Permanent` / `General`, `NoEmail`                 | any of 5.2.2, 5.2.3, 5.3.x, 5.6.x, 5.7.x | `MessageOnly` |
 * | `Permanent` / `General`, `NoEmail`                 | only 5.1.1 and 5.1.10                | `AddressUnknown` |
 * | `Permanent` / `General`, `NoEmail`                 | anything else, or none               | `AddressSuspect` |
 * | `Permanent` / any other subtype                    | any                                  | `MessageOnly`    |
 *
 * - `AddressUnknown`: the server said the mailbox doesn't exist (5.1.1 "bad destination mailbox
 *   address") or the domain accepts no mail at all (5.1.10, null MX, RFC 7505). Pause at once.
 * - `Suppressed`: SES didn't even try, because the address is on the global or our account's
 *   suppression list, which only gets dead addresses. Pause at once.
 * - `AddressSuspect`: a hard bounce that doesn't say why clearly enough (5.1.x other than the two
 *   above, 5.2.1 mailbox disabled, 5.4.x routing, 5.5.x, 5.0.0, no code). Counts once per
 *   message; {@link THRESHOLD} of them within {@link WINDOW} pause.
 * - `MessageOnly`: about this message (mailbox full, too big, content, policy, spam, DMARC, a
 *   subtype SES doesn't document as permanent), or not final. Nothing about the address changes.
 *
 * A diagnostic that names a content or policy code wins over a status that names an address code:
 * the address can be told dead by the next message, but a pause can't be taken back by itself.
 */
export const Verdict = Schema.TaggedUnion({
  AddressUnknown: {},
  Suppressed: {},
  AddressSuspect: {},
  MessageOnly: { reason: Schema.Literals(["not-permanent", "content", "unlisted-subtype"]) },
});
export type Verdict = typeof Verdict.Type;

const messageOnly = (reason: Extract<Verdict, { _tag: "MessageOnly" }>["reason"]) =>
  Verdict.cases.MessageOnly.make({ reason });

/** `AddressSuspect` bounces of distinct messages that pause forwarding… */
export const THRESHOLD = 3;
/** …when they all fall within this window. */
export const WINDOW = Duration.weeks(1);

/** Enhanced status codes (RFC 3463 `class.subject.detail`) anywhere in a DSN field. */
const ENHANCED_CODE = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/g;

interface Code {
  readonly statusClass: number;
  readonly subject: number;
  readonly detail: number;
}

const codes = (field: Option.Option<string>): ReadonlyArray<Code> =>
  Option.match(field, {
    onNone: () => [],
    onSome: (text) =>
      Arr.map(Arr.fromIterable(text.matchAll(ENHANCED_CODE)), (match) => ({
        statusClass: Number(match[1]),
        subject: Number(match[2]),
        detail: Number(match[3]),
      })),
  });

/**
 * About the message rather than the mailbox, RFC 3463: §3.3 (X.2.2 mailbox full, X.2.3 message too
 * long), §3.4 (X.3.x mail system), §3.7 (X.6.x content or media), §3.8 (X.7.x security or policy).
 */
const isAboutMessage = ({ subject, detail }: Code) =>
  (subject === 2 && (detail === 2 || detail === 3)) ||
  subject === 3 ||
  subject === 6 ||
  subject === 7;

/** 5.1.1 "bad destination mailbox address" (RFC 3463 §3.2) and "no mail at all" (RFC 7505 §4.2). */
const isAddressUnknown = ({ statusClass, subject, detail }: Code) =>
  statusClass === 5 && subject === 1 && (detail === 1 || detail === 10);

export const classify = (
  bounce: Pick<SendingEvent.Bounce["bounce"], "bounceType" | "bounceSubType">,
  recipient: SendingEvent.BouncedRecipient,
): Verdict => {
  if (bounce.bounceType !== "Permanent") return messageOnly("not-permanent");
  if (
    bounce.bounceSubType === "Suppressed" ||
    bounce.bounceSubType === "OnAccountSuppressionList"
  ) {
    return Verdict.cases.Suppressed.make({});
  }
  if (bounce.bounceSubType !== "General" && bounce.bounceSubType !== "NoEmail") {
    return messageOnly("unlisted-subtype");
  }
  const found = [
    ...codes(Option.fromUndefinedOr(recipient.status)),
    ...codes(Option.fromUndefinedOr(recipient.diagnosticCode)),
  ];
  if (Arr.some(found, isAboutMessage)) return messageOnly("content");
  if (Arr.isArrayNonEmpty(found) && Arr.every(found, isAddressUnknown)) {
    return Verdict.cases.AddressUnknown.make({});
  }
  return Verdict.cases.AddressSuspect.make({});
};
