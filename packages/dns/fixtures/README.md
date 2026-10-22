# DNS over HTTPS (JSON) fixtures

The DoH JSON format has no RFC. Cloudflare follows Google's schema ("Cloudflare has chosen to follow
the same schema as Google's DNS over HTTPS resolver"), so both providers' documented examples and
real answers from both are here. `Doh.Response` (`src/Doh.ts`) must decode every success fixture,
`tools/doh-emulator` must produce answers it decodes too, and its contract test replays the
`recorded-cloudflare-*` queries against a zone holding the same records.

| File                      | Source                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare-example.json` | https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/ (example)                                       |
| `cloudflare-error.json`   | same page, the 400 Bad Request example                                                                                                          |
| `google-a.json`           | https://developers.google.com/speed/public-dns/docs/doh/json ("A successful response")                                                          |
| `google-servfail.json`    | same page ("A failure response with diagnostic information")                                                                                    |
| `google-spf.json`         | same page (first "SPF and TXT records" example)                                                                                                 |
| `google-txt.json`         | same page (second example, the DKIM TXT record split into two strings, which has no `TTL`)                                                      |
| `recorded-*.json`         | real answers, recorded on 2026-10-22 with `curl -H 'accept: application/dns-json'` from `cloudflare-dns.com/dns-query` and `dns.google/resolve` |

The Google page annotates its examples with `//` comments, which the copies drop, along with the
trailing comma after the last array in the TXT example. Nothing else changed.

Recorded queries (name, type): `gmail.com MX` (`recorded-cloudflare-mx`), `www.github.com TXT`
(a CNAME followed to `github.com`, whose SPF record Cloudflare prints as two quoted strings:
`recorded-cloudflare-txt-via-cname`; the same query to Google prints every TXT record unquoted:
`recorded-google-txt-via-cname`), `www.github.com CNAME`, `zz9q-nonexistent-domain-alias.com MX`
(NXDOMAIN, status 3), `github.com AAAA` (no such record: status 0 with only the zone's SOA in
`Authority`), `example.com MX` (a null MX, RFC 7505), `_dmarc.example.com TXT`, `GMail.com.` with type `mx` (`recorded-cloudflare-mx-case`), and three HTTP 400s: `bad..name MX`
(`recorded-cloudflare-error`), type `BOGUS` (`recorded-cloudflare-error-type`) and no `name`
(`recorded-cloudflare-error-name`). Without the `accept: application/dns-json` header Cloudflare
answers 400 with an empty body (not recorded as a file).

What the recordings show beyond the docs: Cloudflare writes owner names without the trailing dot
(the documented example has it; Google's answers have it) but CNAME and MX targets with it; it
echoes the asked name in its letter case and without a trailing dot, and takes the type in any case.
