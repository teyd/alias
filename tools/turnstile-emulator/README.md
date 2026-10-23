# Turnstile emulator

Cloudflare Turnstile for tests and `pnpm dev`, on the paths Cloudflare serves it from, for the
[documented test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) only
(`src/TestKeys.ts`):

- `POST /turnstile/v0/siteverify` (form or JSON): answers as Cloudflare answered the same
  requests when recorded (`packages/turnstile/fixtures/README.md`). The contract test replays every
  recording and decodes each answer with the production schema.
- `GET /turnstile/v0/api.js`: the widget's documented JavaScript API, so browser tests never load
  Cloudflare's script. Its behaviour per site key was recorded from Cloudflare's own `api.js`
  (below); `browser/test/turnstile.test.ts` runs the same probe against the emulator's script.

## The widget, as recorded

On 2026-10-23, a page on `http://localhost` loaded
`https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=ready` in headless
Chromium (Playwright 1.64.1) and called `turnstile.render("#w", { sitekey, action: "signup", … })`:

| Site key                   | What happened                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1x00000000000000000000AA` | `onload` ran with `turnstile` holding `execute, getResponse, isExpired, ready, remove, render, reset` (and `_private`); `render` returned `cf-chl-widget-<5 chars>`; `callback("XXXX.DUMMY.TOKEN.XXXX")`, `getResponse` returning the same; a hidden `cf-turnstile-response` input in the container held it; the iframe was 65 px high |
| `2x00000000000000000000AB` | `error-callback("600010")`; the input stayed empty                                                                                                                                                                                                                                                                                     |
| `1x00000000000000000000BB` | as the first, but invisible (0 px)                                                                                                                                                                                                                                                                                                     |
| `2x00000000000000000000BB` | as the second, invisible                                                                                                                                                                                                                                                                                                               |

## Not emulated

Real tokens (production keys, their single use and 300-second expiry, `hostname`), multipart
request bodies, `cData`, the widget's options beyond `sitekey`, the callbacks and
`response-field-name`, its languages and appearance (it draws a plain box, not Cloudflare's
iframe), and the interactive key `3x00000000000000000000FF` beyond one checkbox. An unknown site
key fails with `400020` (invalid sitekey) as the client-side error codes describe; that was not
recorded.
