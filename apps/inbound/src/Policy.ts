import type { SesEvent } from "@alias/aws";
import { Address, Mail } from "@alias/core";
import type { AliasRepo, RecipientRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The pipeline's decisions that need no I/O (PLAN.md §19.2, "functional core"). `Pipeline.ts`
 * looks things up and acts; this module only decides.
 */

/** Why mail to a recipient was not passed on. Logged without any address or content. */
export const DropReason = Schema.Literals([
  // Not a valid address, or a domain we don't serve yet.
  "unroutable",
  "unknown-alias",
  "inactive-alias",
  // Inbox mode (temp mail) stores mail instead of forwarding it: roadmap phase 7.
  "inbox-mode",
  // The alias owner has no verified forwarding address.
  "no-recipient",
  "virus",
  "spam",
  // Neither a `From` address nor an envelope sender to reply to.
  "no-sender",
  // The sender address is too long for a reverse alias; contacts (phase 4) will fix that.
  "unencodable-sender",
  // A reverse alias whose token we didn't sign for this alias.
  "bad-token",
  // A reply without DKIM and DMARC passing: the owner's address may be spoofed.
  "unauthenticated-reply",
  // A reply from someone other than the alias owner's verified recipients.
  "foreign-reply-sender",
  // The spool no longer holds the message (processed earlier, or expired).
  "spool-missing",
  "malformed-message",
  // SES refused the rewritten message itself; sending it again would fail the same way.
  "rejected",
  // Mail that already went through this alias, or made more hops than any real path needs.
  "loop",
  // Machine-sent mail to a reverse alias (RFC 3834): an out-of-office reply or a read receipt
  // from the owner's mailbox. The contact only gets what the owner writes.
  "auto-reply",
  // A delivery report with an empty envelope sender, sent to a reverse alias.
  "bounce",
  // Past the alias's hourly forward cap.
  "rate-limited",
  // Bigger than the pipeline loads into memory.
  "too-large",
]);
export type DropReason = typeof DropReason.Type;

/**
 * What happens to mail SES marks as spam. Today it is always dropped. A per-user quarantine
 * setting (PLAN.md §3.2) adds a `"quarantine"` case here and reads the owner's choice in
 * {@link spamAction}; the pipeline already asks per alias.
 */
type SpamAction = "drop";

export const spamAction = (_alias: AliasRepo.Alias): SpamAction => "drop";

type Receipt = SesEvent.SesEvent["Records"][number]["ses"]["receipt"];

/**
 * Drops on SES's virus and spam verdicts, before any rewriting or sending. Only `FAIL` counts:
 * `GRAY`, `PROCESSING_FAILED` and `DISABLED` pass, as SES leaves those undecided.
 */
export const screen = (
  receipt: Receipt,
  onSpam: SpamAction,
): Option.Option<Extract<DropReason, "virus" | "spam">> => {
  if (receipt.virusVerdict.status === "FAIL") return Option.some("virus");
  return receipt.spamVerdict.status === "FAIL" && onSpam === "drop"
    ? Option.some("spam")
    : Option.none();
};

/** Where forwarded mail goes: the owner's default recipient, which is always a verified one. */
export const forwardTarget = (
  recipients: ReadonlyArray<RecipientRepo.Recipient>,
): Option.Option<RecipientRepo.Recipient> =>
  Arr.findFirst(
    recipients,
    (recipient) => recipient.isDefault && Option.isSome(recipient.verifiedAt),
  );

/** Who wrote the mail: the first `From` mailbox SES parsed, else the envelope sender. */
export const sender = (mail: SesEvent.SesMail): Option.Option<Mail.Sender> =>
  Option.fromUndefinedOr(mail.commonHeaders.from).pipe(
    Option.flatMap(Arr.head),
    Option.flatMap(Mail.parseSender),
    Option.orElse(() => Mail.parseSender(mail.source)),
  );

/**
 * A reply leaves through the alias only when it provably comes from the alias owner: SES saw
 * DKIM and DMARC pass, so the `From` domain is authenticated, and the `From` address is one of
 * the owner's verified recipients. Anything else could be someone spoofing the owner to send as
 * the alias. None means the reply may go out.
 */
export const rejectReply = (
  receipt: Receipt,
  from: Option.Option<string>,
  recipients: ReadonlyArray<RecipientRepo.Recipient>,
): Option.Option<Extract<DropReason, "unauthenticated-reply" | "foreign-reply-sender">> => {
  if (receipt.dkimVerdict.status !== "PASS" || receipt.dmarcVerdict.status !== "PASS") {
    return Option.some("unauthenticated-reply");
  }
  const verified = Arr.filter(recipients, (recipient) => Option.isSome(recipient.verifiedAt));
  const isOwner = Option.exists(from, (address) =>
    Arr.some(verified, (recipient) => recipient.address === address.toLowerCase()),
  );
  return isOwner ? Option.none() : Option.some("foreign-reply-sender");
};

/**
 * More `Received` fields than this is a loop. RFC 5321 §6.3 recommends counting them; 50 is
 * Postfix's `hopcount_limit`. Real mail crosses a handful of hops.
 */
export const MAX_HOPS = 50;

/** RFC 5321 §4.5.5: only notifications (bounces and the like) use the null reverse-path `<>`. */
const isNullSender = (source: string) => source === "" || source === "<>";

const DAEMONS = ["mailer-daemon", "postmaster"];

const fromDaemon = (mail: SesEvent.SesMail) =>
  Option.exists(sender(mail), ({ address }) =>
    Arr.contains(DAEMONS, address.slice(0, address.lastIndexOf("@")).toLowerCase()),
  );

const isOwnerAddress = (
  recipients: ReadonlyArray<RecipientRepo.Recipient>,
  address: Option.Option<string>,
) =>
  Option.exists(address, (value) =>
    Arr.some(recipients, (recipient) => recipient.address === value.toLowerCase()),
  );

/**
 * Loop detection on the forward path, once the message's header block is read:
 * - it carries our own forward marker for this alias (`Mail.forward` adds it);
 * - it made more than {@link MAX_HOPS} hops;
 * - it is machine-sent (`Auto-Submitted`, `Precedence: bulk|junk|list`) by the owner's own
 *   mailbox, i.e. an auto-forward or auto-reply rule feeding mail back into the alias.
 *
 * Automated mail from anyone else forwards as usual: newsletters and notifications are what
 * many aliases exist for.
 */
export const forwardLoop = (
  signals: Mail.Signals,
  alias: Address.MailAddress,
  mail: SesEvent.SesMail,
  recipients: ReadonlyArray<RecipientRepo.Recipient>,
): Option.Option<Extract<DropReason, "loop">> => {
  const fromOwner =
    isOwnerAddress(
      recipients,
      Option.map(sender(mail), (found) => found.address),
    ) || isOwnerAddress(recipients, Option.some(mail.source));
  return Arr.contains(signals.forwardedBy, Address.format(alias)) ||
    signals.hops > MAX_HOPS ||
    (signals.isAutomated && fromOwner)
    ? Option.some("loop")
    : Option.none();
};

/**
 * What a reverse alias refuses before a reply is authenticated: bounces (an empty envelope
 * sender on a report, an automated message or one from a mailer daemon), then any other
 * machine-sent mail (RFC 3834 §2: automatic responses must not go to automated mail's sender,
 * and our contacts should only ever hear from the owner).
 */
export const automatedReply = (
  signals: Mail.Signals,
  mail: SesEvent.SesMail,
): Option.Option<Extract<DropReason, "bounce" | "auto-reply">> => {
  if (isNullSender(mail.source) && (signals.isReport || signals.isAutomated || fromDaemon(mail))) {
    return Option.some("bounce");
  }
  return signals.isAutomated || signals.isReport ? Option.some("auto-reply") : Option.none();
};
