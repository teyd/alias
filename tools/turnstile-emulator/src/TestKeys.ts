/**
 * Turnstile's documented test keys, the only keys the emulator knows. They work on any hostname,
 * `localhost` included; production keys never accept the dummy token.
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */

/** The token every test site key hands out. */
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

export const siteKeys = {
  passes: "1x00000000000000000000AA",
  blocks: "2x00000000000000000000AB",
  passesInvisible: "1x00000000000000000000BB",
  blocksInvisible: "2x00000000000000000000BB",
  /** Shows a challenge the visitor must click; passes once they do. */
  interactive: "3x00000000000000000000FF",
} as const;

export const secrets = {
  passes: "1x0000000000000000000000000000000AA",
  fails: "2x0000000000000000000000000000000AA",
  /** Answers every token with `timeout-or-duplicate`, as if already redeemed. */
  spent: "3x0000000000000000000000000000000AA",
} as const;
