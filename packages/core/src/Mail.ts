import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as Address from "./Address.ts";
import * as Headers from "./internal/headers.ts";
import { mailboxField, sanitize } from "./internal/phrase.ts";

/**
 * Header rewrites for the two mail paths (PLAN.md §3.2). Both work on raw RFC 5322 bytes and
 * change header fields only: the subject, the MIME structure and every body byte go out as
 * they came in.
 */

/** Who sent the mail being forwarded: the display name and address from its `From`. */
export interface Sender {
  readonly name: Option.Option<string>;
  readonly address: string;
}

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

const isAlwaysRemoved = (name: string) =>
  HashSet.has(ALWAYS_REMOVED, name) || name.startsWith("x-ses-");

/**
 * Replies also lose what identifies the user's own machine and mail client (PLAN.md §3.4), and
 * `To`, which held the reverse alias. `Received` is kept on forwarded mail: it is the sender's
 * trace, not the user's, and hop counting depends on it.
 */
const REPLY_REMOVED = HashSet.make("received", "x-originating-ip", "user-agent", "x-mailer", "to");

const isReplyRemoved = (name: string) => isAlwaysRemoved(name) || HashSet.has(REPLY_REMOVED, name);

/**
 * Prepares inbound mail for the alias owner. `From` and `Reply-To` become
 * `"Name (sender@x)" <alias+r.<token>@domain>`, so the user sees who wrote and a reply goes
 * back through the reverse alias. The token comes from `ReverseToken.mint`.
 */
export const forward = Effect.fn("Mail.forward")(function* (
  raw: Uint8Array,
  options: {
    readonly alias: Address.MailAddress;
    readonly sender: Sender;
    readonly token: string;
  },
) {
  const message = yield* Headers.parse(raw);
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
  return Headers.rewrite(message, isAlwaysRemoved, [
    mailboxField("From", display, reverse, message.lineEnding),
    mailboxField("Reply-To", display, reverse, message.lineEnding),
  ]);
});

/**
 * Prepares the alias owner's reply for the contact: `From` becomes the alias, `To` the contact
 * the reverse alias stood for, and fields that identify the user's mailbox, client or network
 * are removed. Quoted text is not touched yet.
 */
export const reply = Effect.fn("Mail.reply")(function* (
  raw: Uint8Array,
  options: { readonly alias: Address.MailAddress; readonly to: string },
) {
  const message = yield* Headers.parse(raw);
  return Headers.rewrite(message, isReplyRemoved, [
    `From: ${Address.format(options.alias)}`,
    `To: ${sanitize(options.to)}`,
  ]);
});
