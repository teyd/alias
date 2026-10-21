import * as Arr from "effect/Array";
import * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/**
 * Usernames become mail subdomains (`<username>.alias.example`), so they must be one DNS label
 * that nobody can mistake for another user's or for ours.
 *
 * - Only `a-z`, `0-9` and `-`, 3 to 30 characters, starting with a letter. Input is lowercased;
 *   anything outside ASCII (Cyrillic `а`, fullwidth `ａ`, accents…) is rejected outright, which
 *   removes cross-script confusables.
 * - No leading, trailing or doubled hyphen. `--` also rules out punycode (`xn--…`).
 * - ASCII lookalikes (`0`/`o`, `1`/`l`/`i`, `rn`/`m`, `vv`/`w`) fold into one {@link skeleton}.
 *   The skeleton is what must be unique and what the reserved list is checked against, so
 *   `paypa1` is reserved and `j0hn` is taken once `john` exists.
 */
export type Username = Brand.Branded<string, "Username">;
const Username = Brand.nominal<Username>();

const MIN_LENGTH = 3;
const MAX_LENGTH = 30;

export const InvalidUsernameReason = Schema.Literals([
  "too-short",
  "too-long",
  "invalid-characters",
  "must-start-with-letter",
  "hyphen-placement",
  "reserved",
]);
export type InvalidUsernameReason = typeof InvalidUsernameReason.Type;

class InvalidUsername extends Schema.TaggedError<InvalidUsername>()("InvalidUsername", {
  input: Schema.String,
  reason: InvalidUsernameReason,
}) {}

/** Pairs are applied in order; multi-letter lookalikes go first so `rn` folds before `r`. */
const CONFUSABLES: ReadonlyArray<readonly [string, string]> = [
  ["rn", "m"],
  ["vv", "w"],
  ["cl", "d"],
  ["0", "o"],
  ["1", "l"],
  ["i", "l"],
  ["5", "s"],
  ["-", ""],
];

/** The confusable-folded form of a username. Two usernames clash when their skeletons match. */
export const skeleton = (username: string): string =>
  Arr.reduce(CONFUSABLES, username, (folded, [from, to]) => folded.replaceAll(from, to));

/**
 * Infrastructure labels, mail role accounts (RFC 2142) and names a phisher would want. Compared by
 * skeleton, so lookalikes of these are reserved too.
 */
const RESERVED: ReadonlyArray<string> = [
  // infrastructure and DNS
  "www",
  "mail",
  "email",
  "smtp",
  "imap",
  "pop",
  "pop3",
  "mx",
  "ns",
  "ns1",
  "ns2",
  "dns",
  "ftp",
  "sftp",
  "ssh",
  "vpn",
  "autoconfig",
  "autodiscover",
  "mta-sts",
  "dkim",
  "dmarc",
  "spf",
  "bimi",
  "cdn",
  "static",
  "assets",
  "media",
  "img",
  "api",
  "app",
  "web",
  "dev",
  "staging",
  "test",
  "beta",
  "status",
  "localhost",
  // role accounts and product surfaces
  "admin",
  "administrator",
  "root",
  "system",
  "sysadmin",
  "postmaster",
  "hostmaster",
  "webmaster",
  "abuse",
  "security",
  "noreply",
  "no-reply",
  "mailer-daemon",
  "support",
  "help",
  "info",
  "contact",
  "billing",
  "sales",
  "legal",
  "privacy",
  "account",
  "accounts",
  "login",
  "logout",
  "signin",
  "signup",
  "register",
  "auth",
  "oauth",
  "sso",
  "me",
  "settings",
  "dashboard",
  "docs",
  "blog",
  "news",
  "temp",
  "tmp",
  "reply",
  "bounce",
  "bounces",
  "official",
  "staff",
  "team",
  "moderator",
  // our own names
  "alias",
  "aliases",
  // brands people get phished as
  "google",
  "gmail",
  "apple",
  "icloud",
  "microsoft",
  "outlook",
  "hotmail",
  "live",
  "office",
  "yahoo",
  "proton",
  "protonmail",
  "tutanota",
  "fastmail",
  "amazon",
  "aws",
  "cloudflare",
  "paypal",
  "stripe",
  "github",
  "gitlab",
  "facebook",
  "instagram",
  "whatsapp",
  "meta",
  "twitter",
  "linkedin",
  "netflix",
  "spotify",
  "steam",
  "discord",
  "telegram",
  "signal",
  "bitwarden",
  "1password",
  "addy",
  "simplelogin",
  "anonaddy",
  "duckduckgo",
  "firefox",
  "mozilla",
  "visa",
  "mastercard",
  "bank",
  "coinbase",
  "binance",
];

const reservedSkeletons = HashSet.fromIterable(Arr.map(RESERVED, skeleton));

const isReserved = (username: string): boolean =>
  HashSet.has(reservedSkeletons, skeleton(username));

const ALLOWED = /^[a-z0-9-]+$/;
const STARTS_WITH_LETTER = /^[a-z]/;

/** Validates and normalizes (trim + lowercase) a requested username. */
export const parse = Effect.fn("Username.parse")(function* (input: string) {
  const username = Str.toLowerCase(Str.trim(input));
  const fail = (reason: InvalidUsernameReason) =>
    Effect.fail(new InvalidUsername({ input, reason }));
  if (username.length < MIN_LENGTH) return yield* fail("too-short");
  if (username.length > MAX_LENGTH) return yield* fail("too-long");
  if (!ALLOWED.test(username)) return yield* fail("invalid-characters");
  if (!STARTS_WITH_LETTER.test(username)) return yield* fail("must-start-with-letter");
  if (username.endsWith("-") || username.includes("--")) return yield* fail("hyphen-placement");
  if (isReserved(username)) return yield* fail("reserved");
  return Username(username);
});
