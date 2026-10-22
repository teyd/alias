# Mail corpus (PLAN.md §19.2, point 11)

## Replies

Anonymized replies the way the major clients write them, as SES stores them (CRLF, trace and
signature headers on top). `Mail.test.ts` runs `Mail.reply` on each `<name>.eml` and compares the
result byte for byte with `<name>.expected.eml`.

| File                 | Shape                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `gmail-alternative`  | Gmail: plain 7bit + HTML quoted-printable, nested quotes, attribution wrapped over two lines, owner's own signature |
| `apple-mail`         | Apple Mail: plain and HTML quoted-printable, `<blockquote type="cite">` with the attribution inside                 |
| `thunderbird-flowed` | Thunderbird in German: `format=flowed`, 8bit UTF-8, `Am … schrieb …:`                                               |
| `outlook-base64`     | Outlook: plain and HTML base64, top-posted, `From:/Sent:/To:` block after a rule                                    |
| `latin1-qp`          | ISO-8859-1 quoted-printable with a non-ASCII owner name                                                             |
| `attachment-mixed`   | multipart/mixed: quoted reply, a PDF and an attached text file (both untouched)                                     |
| `nothing-to-scrub`   | No owner data in the body: it must come through byte for byte                                                       |

The owner is `Ada Lovelace` (`ada@mailbox.example`, `ada.work@office.example`), or `Zoë Müller`
(`zoe@mailbox.example`) for `latin1-qp`; the alias is `shop@ada.alias.test`.

The expected files are reviewed snapshots. After a deliberate change, regenerate them from the
test's inputs, read every diff (decode quoted-printable and base64 parts), and commit them with
the change.

## Forwards (tracker protection, PLAN.md §20.19)

Newsletters and notifications as SES stores them. `Trackers.test.ts` runs `Mail.forward` on each
`forward-<name>.eml` (images `block-trackers`; link cleaning on except for `related-attachment`)
and compares the result byte for byte with `forward-<name>.expected.eml`. Forwarding the output
again must change no body byte, and the test-side MIME decoder must find no tracker in any inline
text part.

| File                         | Shape                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `forward-mailchimp`          | Mailchimp: plain 7bit + HTML quoted-printable, `list-manage.com/track/open.php` pixel, UTM and `mc_*` links                      |
| `forward-sendgrid-base64`    | SendGrid: base64 HTML, `/wf/open` pixel, a 1 px spacer, a `@media print` CSS tracker, a click redirect (kept)                    |
| `forward-related-attachment` | multipart/mixed + related: `cid:` banner (kept), `display:none` pixel, a PDF and an attached HTML file (both untouched)          |
| `forward-latin1-qp`          | ISO-8859-1 quoted-printable: tracker `background` attribute, unquoted `width=1 height=1`, Outlook VML comment                    |
| `forward-mailchimp-proxied`  | `forward-mailchimp.eml` in `proxy-images` mode: the logo points at the image proxy (signed with the test key), the pixel is gone |
| `forward-nothing-to-protect` | Visible images and plain links only: the body must come through byte for byte                                                    |

The expected outputs were read back with Python's `email` package: only the trackers and tracking
parameters listed above differ, and every non-text part decodes to the same bytes.

## PGP corpus (`pgp/`, PLAN.md §20.21)

Messages as `Mail.forward` hands them to `Pgp.encrypt` (CRLF, reverse alias in `From`, our loop
marker). `Pgp.test.ts` encrypts each `<name>.eml`, compares the result with the armor replaced by
`<armored OpenPGP message>` to `<name>.expected.eml`, and decrypts it to `<name>.payload.eml`.
`pgp-mime` and `smime-enveloped` must pass through unchanged and have no expected files.

| File                | Shape                                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| `signed`            | `multipart/signed` (PGP): the signed part must survive byte for byte           |
| `no-content-type`   | No MIME fields at all: the payload starts with the blank line                  |
| `smime-signed-data` | S/MIME opaque signed data: not encryption, so it is encrypted                  |
| `subject-hidden`    | Folded `To`, encoded-word `Subject`, `Keywords`, `Comments`: header protection |
| `pgp-mime`          | Already PGP/MIME encrypted                                                     |
| `smime-enveloped`   | Already S/MIME encrypted (`smime-type=enveloped-data`)                         |

Regenerate after a deliberate change from the test's inputs, read every diff, and decrypt the
payloads with a second implementation (Sequoia, GnuPG) before committing them.
