import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Str from "effect/String";
import * as Address from "./Address.ts";
import { decode as decodeWords } from "./internal/encodedWords.ts";
import * as Headers from "./internal/headers.ts";
import * as Mime from "./internal/mime.ts";
import { mailboxField, sanitize } from "./internal/phrase.ts";
import { scrub } from "./internal/scrub.ts";
import * as Trackers from "./internal/trackers.ts";

/**
 * Rewrites for the two mail paths (PLAN.md §3.2). Both work on raw RFC 5322 bytes. Forwarding
 * changes header fields and takes trackers out of text parts; replying takes the owner's identity
 * out of them. The subject, the MIME structure and every other body byte go out as they came in.
 */

/** Who sent the mail being forwarded: the display name and address from its `From`. */
export interface Sender {
  readonly name: Option.Option<string>;
  readonly address: string;
}

/** `display <local@domain>`, with the address in angle brackets at the end. */
const NAME_ADDR = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/s;
/** A bare `local@domain`, optionally followed by an old-style `(comment)` name. */
const ADDR_SPEC = /^([^<>\s"(),]+@[^<>\s"(),]+)(?:\s*\((.*)\))?$/s;

const unquote = (phrase: string) =>
  phrase.startsWith('"') && phrase.endsWith('"') && phrase.length >= 2
    ? phrase.slice(1, -1).replace(/\\(.)/g, "$1")
    : phrase;

const displayName = (phrase: Option.Option<string>): Option.Option<string> =>
  phrase.pipe(
    Option.map((text) => decodeWords(unquote(text.trim())).trim()),
    Option.filter(Str.isNonEmpty),
  );

/**
 * Reads the first mailbox of a `From` field value, as SES lists it in `commonHeaders.from`:
 * `"Café Müller" <news@cafe.example>`, `=?UTF-8?Q?...?= <...>`, or a bare address. The name is
 * decoded for display; none when the value holds no usable address.
 */
export const parseSender = (value: string): Option.Option<Sender> => {
  const text = value.trim();
  const nameAddr = NAME_ADDR.exec(text);
  if (nameAddr !== null) {
    return Option.some({
      name: displayName(Option.fromUndefinedOr(nameAddr[1])),
      address: nameAddr[2] ?? "",
    });
  }
  const addrSpec = ADDR_SPEC.exec(text);
  return addrSpec === null
    ? Option.none()
    : Option.some({
        name: displayName(Option.fromUndefinedOr(addrSpec[2])),
        address: addrSpec[1] ?? "",
      });
};

/**
 * Fields neither path may pass on.
 *
 * - `From`, `Sender`, `Reply-To`, `Return-Path`: SES rejects raw mail whose From, Sender or
 *   Return-Path is not a verified identity, and each of them names someone other than the alias.
 *   `Return-Path` is added at final delivery and must not travel (RFC 5321 §4.4).
 * - `DKIM-Signature`, `DomainKey-Signature`, `X-Google-DKIM-Signature`, `ARC-*`: they sign the
 *   headers we change, so they would fail; SES signs for the alias domain instead. On replies
 *   their `d=` would also name the user's real mail provider.
 * - `Authentication-Results`, `Received-SPF`, `X-SES-*`: our inbound SES verdicts for the
 *   original sender. Downstream they would describe a different From, and `X-SES-*` carries SES
 *   receipt internals.
 * - `Disposition-Notification-To`, `Return-Receipt-To`: a read receipt goes straight to that
 *   address from the user's real mailbox, bypassing the alias.
 */
const ALWAYS_REMOVED = HashSet.make(
  "from",
  "sender",
  "reply-to",
  "return-path",
  "dkim-signature",
  "domainkey-signature",
  "x-google-dkim-signature",
  "arc-seal",
  "arc-message-signature",
  "arc-authentication-results",
  "authentication-results",
  "received-spf",
  "disposition-notification-to",
  "return-receipt-to",
);

const isAlwaysRemoved = ({ name }: Headers.Field) =>
  HashSet.has(ALWAYS_REMOVED, name) || name.startsWith("x-ses-");

/**
 * The field {@link forward} adds, naming the alias that forwarded the message. Mail that comes
 * back to the same alias still carrying it went round in a loop (see {@link signals}).
 */
const FORWARD_MARKER = "X-Alias-Forwarded";

/**
 * Fields {@link forward} adds when tracker protection changed the body, with how many trackers
 * or links it changed. Incoming ones are removed: they describe this hop only.
 */
const TRACKERS_REMOVED = "X-Alias-Trackers-Removed";
const LINKS_CLEANED = "X-Alias-Links-Cleaned";
const PROTECTION_FIELDS = HashSet.make(TRACKERS_REMOVED.toLowerCase(), LINKS_CLEANED.toLowerCase());

export type Protection = Trackers.Protection;

/** The first token of a structured value, without `;` parameters or `(comments)`, lowercased. */
const token = (value: string) =>
  value
    .replace(/\([^)]*\)/g, " ")
    .split(";")[0]
    ?.trim()
    .toLowerCase() ?? "";

/**
 * Replies also lose what identifies the user's own machine and mail client (PLAN.md §3.4), `To`,
 * which held the reverse alias, `Message-ID`, whose domain names the user's mail provider, and
 * our forward marker, which names the alias the contact may not know. `Received` is kept on
 * forwarded mail: it is the sender's trace, not the user's, and hop counting depends on it.
 */
const REPLY_REMOVED = HashSet.make(
  "received",
  "x-originating-ip",
  "user-agent",
  "x-mailer",
  "to",
  "message-id",
  FORWARD_MARKER.toLowerCase(),
);

const isReplyRemoved = (field: Headers.Field) =>
  isAlwaysRemoved(field) || HashSet.has(REPLY_REMOVED, field.name);

/**
 * Prepares inbound mail for the alias owner. `From` and `Reply-To` become
 * `"Name (sender@x)" <alias+r.<token>@domain>`, so the user sees who wrote and a reply goes
 * back through the reverse alias. The token comes from `ReverseToken.mint`. An
 * `X-Alias-Forwarded: <alias>` field marks the copy, and markers from other aliases stay, so a
 * loop through several aliases is still caught when it comes back to one of them.
 *
 * `protection` takes tracking images and, if asked, click-tracking parameters out of the text
 * parts (PLAN.md §20.19). Only parts that change are re-encoded (in their own transfer encoding),
 * and `X-Alias-Trackers-Removed: <n>` / `X-Alias-Links-Cleaned: <n>` say what changed.
 */
export const forward = Effect.fn("Mail.forward")(function* (
  raw: Uint8Array,
  options: {
    readonly alias: Address.MailAddress;
    readonly sender: Sender;
    readonly token: string;
    readonly protection: Protection;
  },
) {
  const changes = yield* Ref.make(Trackers.noChanges);
  const message = yield* Mime.rewriteText(yield* Headers.parse(raw), (part) =>
    Option.match(Trackers.protect(options.protection, part), {
      onNone: () => Effect.succeedNone,
      onSome: (rewritten) =>
        Effect.as(
          Ref.update(changes, (total) => Trackers.addChanges(total, rewritten.changes)),
          Option.some(rewritten.text),
        ),
    }),
  );
  const { trackers, links } = yield* Ref.get(changes);
  const senderAddress = sanitize(options.sender.address);
  const display = options.sender.name.pipe(
    Option.map(sanitize),
    Option.filter(
      (name) => Str.isNonEmpty(name) && name.toLowerCase() !== senderAddress.toLowerCase(),
    ),
    Option.match({
      onNone: () => senderAddress,
      onSome: (name) => `${name} (${senderAddress})`,
    }),
  );
  const reverse = Address.format(Address.reverseAddress(options.alias, options.token));
  const alias = Address.format(options.alias);
  // The alias's own earlier marker is replaced, so forwarding a forwarded copy changes nothing.
  const isRemoved = (field: Headers.Field) =>
    isAlwaysRemoved(field) ||
    HashSet.has(PROTECTION_FIELDS, field.name) ||
    (field.name === FORWARD_MARKER.toLowerCase() && token(Headers.value(field)) === alias);
  return Headers.rewrite(message, isRemoved, [
    mailboxField("From", display, reverse, message.lineEnding),
    mailboxField("Reply-To", display, reverse, message.lineEnding),
    `${FORWARD_MARKER}: ${alias}`,
    ...(trackers > 0 ? [`${TRACKERS_REMOVED}: ${trackers}`] : []),
    ...(links > 0 ? [`${LINKS_CLEANED}: ${links}`] : []),
  ]);
});

/** Who the alias owner really is, as far as their reply could give it away. */
export interface Owner {
  /** Every address of theirs: the verified recipients, which their client may quote. */
  readonly addresses: ReadonlyArray<string>;
  /** The display name from their reply's `From`. */
  readonly name: Option.Option<string>;
}

/**
 * Prepares the alias owner's reply for the contact: `From` becomes the alias, `To` the contact
 * the reverse alias stood for, `Message-ID` a new one on the alias's domain, and fields that
 * identify the user's mailbox, client or network are removed. `In-Reply-To` and `References`
 * name the contact's own messages, so threading keeps working.
 *
 * In `text/plain` and `text/html` parts, the owner's addresses become the alias address
 * everywhere, and so does their name in quoted text and attribution lines
 * (`On Tue, Ada <ada@…> wrote:`). Only parts that contain them are re-encoded (in their own
 * transfer encoding); every other byte is copied.
 *
 * `messageId` must be unique (a random UUID, say); it becomes `<messageId@alias domain>`.
 */
export const reply = Effect.fn("Mail.reply")(function* (
  raw: Uint8Array,
  options: {
    readonly alias: Address.MailAddress;
    readonly to: string;
    readonly messageId: string;
    readonly owner: Owner;
  },
) {
  const alias = Address.format(options.alias);
  const message = yield* Mime.rewriteText(yield* Headers.parse(raw), (part) =>
    Effect.succeed(scrub({ ...options.owner, replacement: alias })(part)),
  );
  return Headers.rewrite(message, isReplyRemoved, [
    `From: ${alias}`,
    `To: ${sanitize(options.to)}`,
    `Message-ID: <${options.messageId.replace(/[^\w.-]/g, "")}@${options.alias.domain}>`,
  ]);
});

/** What the header block says about where a message came from, for the loop and bounce checks. */
export interface Signals {
  /** Aliases that forwarded this message before, from our `X-Alias-Forwarded` fields, lowercased. */
  readonly forwardedBy: ReadonlyArray<string>;
  /** `Received` fields: how many hops the message has made. */
  readonly hops: number;
  /**
   * Sent by a machine, not a person: an RFC 3834 `Auto-Submitted` other than `no`, or a
   * `Precedence` of `bulk`, `junk` or `list` (the older convention RFC 3834 §3.1.8 mentions).
   */
  readonly isAutomated: boolean;
  /** A report about other mail (RFC 6522 `multipart/report`): delivery status, read receipts. */
  readonly isReport: boolean;
}

const BULK_PRECEDENCE = HashSet.make("bulk", "junk", "list");

/** Reads the {@link Signals} from a raw message's header block. */
export const signals = Effect.fn("Mail.signals")(function* (raw: Uint8Array) {
  const message = yield* Headers.parse(raw);
  const tokens = (name: string) =>
    Arr.filter(Arr.map(Headers.values(message, name), token), Str.isNonEmpty);
  const result: Signals = {
    forwardedBy: tokens(FORWARD_MARKER),
    hops: Headers.values(message, "received").length,
    isAutomated:
      Arr.some(tokens("auto-submitted"), (value) => value !== "no") ||
      Arr.some(tokens("precedence"), (value) => HashSet.has(BULK_PRECEDENCE, value)),
    isReport: Arr.some(tokens("content-type"), (value) => value === "multipart/report"),
  };
  return result;
});
