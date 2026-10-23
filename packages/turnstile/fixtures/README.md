# Turnstile Siteverify fixtures

`Turnstile.Response` (`src/Turnstile.ts`) must decode every body here, errors included, and
`tools/turnstile-emulator` must answer each recorded request exactly as Cloudflare did (its
contract test replays them; only `challenge_ts` may differ).

| File                          | Source                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `docs-success.json`           | https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ ("API response format", the success example) |
| `docs-failure.json`           | same page, the failure example                                                                                               |
| `docs-testing-success.json`   | https://developers.cloudflare.com/turnstile/troubleshooting/testing/ ("Validation response", success)                        |
| `docs-testing-duplicate.json` | same page, "Token already redeemed"                                                                                          |
| `recorded-*.json`             | real exchanges with `https://challenges.cloudflare.com/turnstile/v0/siteverify`, recorded on 2026-10-23 with `curl`          |

Each recording holds the request as sent (`form` for `application/x-www-form-urlencoded`, `json`
or `raw-json` for `application/json`, `method` for a non-POST), the HTTP status and the JSON body.
Only the documented test secrets were used, so no Cloudflare account was involved:

| Recording                   | Request                                        | Status | Answer                                           |
| --------------------------- | ---------------------------------------------- | ------ | ------------------------------------------------ |
| `recorded-pass`             | always-pass secret `1x…AA`, dummy token, form  | 200    | success                                          |
| `recorded-pass-json`        | the same as JSON, with a `remoteip`            | 200    | success                                          |
| `recorded-pass-any-token`   | always-pass secret, the token `notadummytoken` | 200    | success                                          |
| `recorded-fail`             | always-fail secret `2x…AA`, dummy token        | 200    | `invalid-input-response`                         |
| `recorded-spent`            | "already spent" secret `3x…AA`, dummy token    | 200    | `timeout-or-duplicate`                           |
| `recorded-missing-response` | always-pass secret, empty `response`           | 200    | `missing-input-response`                         |
| `recorded-missing-secret`   | no `secret`                                    | 400    | `missing-input-secret`                           |
| `recorded-invalid-secret`   | a secret that is no key (`0x0000…AA`)          | 400    | `invalid-input-secret`                           |
| `recorded-bad-json`         | `content-type: application/json`, body `{nope` | 400    | `bad-request`, with a message                    |
| `recorded-bad-method`       | `GET`                                          | 405    | `bad-request`, "This API expects POST requests." |

What the recordings show beyond the docs:

- A test secret judges **any** token, not only the dummy `XXXX.DUMMY.TOKEN.XXXX` (the testing page
  says test secrets "only accept the dummy token"). A token of 2049 characters passed too, though
  the docs give 2048 as the maximum; the client refuses longer ones without asking.
- Test-key successes name `hostname: "example.com"` whatever page the widget ran on, carry no
  `action` or `cdata`, and add `metadata: { "result_with_testing_key": true }`.
- Failures carry `messages` (empty unless the request was malformed); the test-key failures also
  carry the `metadata` above. No secret, an unknown secret and a malformed body are HTTP 400, a
  `GET` is 405; every other answer is 200, failures included.
- A missing secret is reported before a missing response (a request with neither answers
  `missing-input-secret`). The same token passes again with an always-pass secret, so test keys
  don't show single use; that needs a production key.
