import { bytes } from "./mime.ts";

/**
 * Realistic messages as they sit in the S3 spool after SES receiving: trace and verdict
 * headers on top, folded DKIM and ARC signatures, encoded words, MIME parts in several
 * transfer encodings.
 */

const lines = (eol: string, ...parts: ReadonlyArray<string>) => parts.join(eol);

/** The header block of a newsletter, without the blank line. */
export const newsletterHeaders = (eol: string) =>
  lines(
    eol,
    "Return-Path: <0100018f-bounce-7c1e@mail.cafe.example>",
    "Received: from mail-a1.cafe.example (mail-a1.cafe.example [192.0.2.10])",
    " by inbound-smtp.eu-west-1.amazonaws.com with SMTP id 4n2l8k;",
    " Tue, 21 Oct 2026 09:14:02 +0000 (UTC)",
    "X-SES-Spam-Verdict: PASS",
    "X-SES-Virus-Verdict: PASS",
    "Received-SPF: pass (spfCheck: domain of mail.cafe.example designates 192.0.2.10 as permitted sender)",
    "Authentication-Results: amazonses.com;",
    " spf=pass (spfCheck: domain of mail.cafe.example designates 192.0.2.10 as permitted sender) smtp.mailfrom=mail.cafe.example;",
    " dkim=pass header.i=@cafe.example;",
    " dmarc=pass header.from=cafe.example;",
    "X-SES-RECEIPT: AEFBQUFBQUFBQUFFTFpXNkhTbE5rMTNmSmQ2a3Q4dUVhVjZ1SlE9PQ==",
    "X-SES-DKIM-SIGNATURE: a=rsa-sha256; q=dns/txt; b=Zm9vYmFy; c=relaxed/simple; s=ihchhvubuqgjsxyuhssfvqohv7z3u4hn; d=amazonses.com; t=1792574042; v=1; bh=abc=; h=From:To:Subject;",
    "ARC-Seal: i=1; a=rsa-sha256; t=1792574040; cv=none; d=relay.example; s=arc;",
    "\tb=dGhpcyBpcyBub3QgYSByZWFsIHNpZ25hdHVyZQ==",
    "ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=relay.example; s=arc;",
    "\th=from:to:subject:date; bh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=;",
    "\tb=c2lnbmF0dXJlIGJ5dGVz",
    "ARC-Authentication-Results: i=1; relay.example; dkim=pass header.d=cafe.example",
    "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=cafe.example;",
    "\ts=sel1; t=1792574040; h=from:to:subject:date:message-id:mime-version;",
    "\tbh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=;",
    "\tb=dGhlIG9yaWdpbmFsIHNpZ25hdHVyZSB3b3VsZCBmYWlsIGFmdGVyIHJld3JpdGluZw==",
    'From: "=?UTF-8?Q?Caf=C3=A9_M=C3=BCller?=" <news@cafe.example>',
    "Sender: bounces@mail.cafe.example",
    "Reply-To: hello@cafe.example",
    "To: k7m2qx9p@alias.test",
    "Subject: =?UTF-8?B?8J+NsCBEaWUgS3VjaGVuLVdvY2hl?= ist da:",
    " neue Rezepte und =?ISO-8859-1?Q?=C4pfel?=",
    "Date: Tue, 21 Oct 2026 09:14:00 +0000",
    "Message-ID: <20261021091400.4f2a@cafe.example>",
    "List-Unsubscribe: <https://cafe.example/u/4f2a>, <mailto:unsub@cafe.example?subject=4f2a>",
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    "Disposition-Notification-To: tracking@cafe.example",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="=_outer_9c1"',
  );

/** Everything from the blank line on: multipart with 8bit, quoted-printable and base64 parts. */
export const newsletterBody = (eol: string): Uint8Array => {
  const text = (value: string) => bytes(value);
  return Uint8Array.from([
    ...text(
      lines(
        eol,
        "",
        "This is a multi-part message in MIME format.",
        "",
        "--=_outer_9c1",
        'Content-Type: multipart/alternative; boundary="=_inner_77"',
        "",
        "--=_inner_77",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        "Grüße aus der Küche! 🍰 Diese Woche: Äpfel, Crème brûlée.",
        "--=_inner_77",
        "Content-Type: text/plain; charset=iso-8859-1",
        "Content-Transfer-Encoding: 8bit",
        "",
        "Gr",
      ),
    ),
    0xfc, // ü in ISO-8859-1: not valid UTF-8 on its own
    ...text(
      lines(
        eol,
        "",
        "--=_inner_77",
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        '<p style=3D"color:red">Gr=C3=BC=C3=9Fe</p><img src=3D"https://t.cafe.e=',
        'xample/p.gif?u=3D4f2a">',
        "--=_inner_77--",
        "",
        "--=_outer_9c1",
        'Content-Type: application/octet-stream; name="menu.bin"',
        "Content-Transfer-Encoding: binary",
        "",
        "",
      ),
    ),
    0x00,
    0xff,
    0x0d,
    0x0a,
    0x0a,
    0x80,
    ...text(lines(eol, "", "--=_outer_9c1--", "")),
  ]);
};

export const newsletter = (eol: string): Uint8Array =>
  Uint8Array.from([...bytes(newsletterHeaders(eol)), ...bytes(eol), ...newsletterBody(eol)]);

/** The alias owner's reply from their own mailbox, addressed to the reverse alias. */
export const ownerReply = (eol: string, reverseAddress: string): Uint8Array =>
  bytes(
    lines(
      eol,
      "Return-Path: <jane.doe@gmail.example>",
      "Received: from [198.51.100.23] (dsl-23.home.example. [198.51.100.23])",
      "        by smtp.gmail.example with ESMTPSA id q7sm1;",
      "        Wed, 22 Oct 2026 08:01:12 -0700 (PDT)",
      "Received: by inbound-smtp.eu-west-1.amazonaws.com with SMTP id 9z;",
      " Wed, 22 Oct 2026 15:01:13 +0000",
      "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=gmail.example; s=20230601;",
      "        h=to:subject:message-id:date:from:in-reply-to:references:mime-version;",
      "        bh=frcCV1k9oG9oKj3dpUqdJg1PxRT2RSN/XKdLCPjaYaY=; b=cmVhbA==",
      "X-Originating-IP: [198.51.100.23]",
      "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 15.1) Thunderbird/140.0",
      "X-Mailer: Apple Mail (2.3826.300.87)",
      'From: "Jane Doe" <jane.doe@gmail.example>',
      "Reply-To: jane.doe+replies@gmail.example",
      `To: "=?UTF-8?Q?Caf=C3=A9_M=C3=BCller_=28news=40cafe=2Eexample=29?=" <${reverseAddress}>`,
      "Cc: friend@other.example",
      "Subject: Re: =?UTF-8?B?8J+NsCBEaWUgS3VjaGVuLVdvY2hl?= ist da",
      "In-Reply-To: <20261021091400.4f2a@cafe.example>",
      "References: <20261021091400.4f2a@cafe.example>",
      "Message-ID: <CAJ8x1=jane@mail.gmail.example>",
      "Date: Wed, 22 Oct 2026 08:01:10 -0700",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "Danke, ich komme gerne!",
      "",
      "On Tue, Oct 21, 2026 at 11:14 Café Müller wrote:",
      "> Grüße aus der Küche!",
      "",
    ),
  );
