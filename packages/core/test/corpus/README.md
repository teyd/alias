# Reply corpus (PLAN.md §19.2, point 11)

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
