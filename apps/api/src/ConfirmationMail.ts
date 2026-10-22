import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

export interface ConfirmationMail {
  readonly sender: string;
  readonly recipient: string;
  readonly username: string;
  /** The web app page that posts the token back (signed in). */
  readonly link: string;
  readonly validFor: Duration.Duration;
  readonly date: DateTime.Utc;
}

/** Where the confirmation link points: the web app's forwarding page, with the secret in the query. */
export const link = (input: {
  readonly origin: string;
  readonly recipientId: string;
  readonly token: string;
}) => {
  const url = new URL("/forwarding", input.origin);
  url.searchParams.set("confirm", input.recipientId);
  url.searchParams.set("token", input.token);
  return url.href;
};

/**
 * The confirmation mail as an RFC 5322 message: plain ASCII text, CRLF line endings. The
 * addresses are validated `Address` values, so they can't smuggle header lines in.
 */
export const render = (mail: ConfirmationMail): Uint8Array => {
  const lines = [
    `From: Alias <${mail.sender}>`,
    `To: <${mail.recipient}>`,
    "Subject: Confirm your forwarding address",
    `Date: ${DateTime.toDateUtc(mail.date).toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=us-ascii",
    "Content-Transfer-Encoding: 7bit",
    "",
    `The Alias account "${mail.username}" wants to forward mail to ${mail.recipient}.`,
    "",
    `If that was you, open this link within ${Duration.toHours(mail.validFor)} hours while signed in to Alias:`,
    "",
    mail.link,
    "",
    "If it wasn't you, ignore this message. Nothing is forwarded until the link is opened.",
    "",
  ];
  return new TextEncoder().encode(Arr.join(lines, "\r\n"));
};
