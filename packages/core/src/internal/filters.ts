import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as Brave from "./lists/brave.ts";
import * as EasyPrivacy from "./lists/easyprivacy.ts";

/**
 * Matches URLs against the vendored tracker lists (`lists/`, refreshed by
 * `scripts/refresh-tracker-lists.ts`; PLAN.md §20.19).
 */

/**
 * The Adblock Plus subset EasyPrivacy's email rules use (the refresh script refuses others): a
 * pattern matches anywhere in the URL, case-insensitively; `*` is any run of characters and `^`
 * a separator (anything but a letter, digit or `_-.%`) or the end. The `image` and
 * `third-party` options always hold for an image in mail, so they are dropped.
 */
const ruleSource = (rule: string) =>
  Arr.map(Array.from(rule.split("$")[0] ?? ""), (char) =>
    char === "*"
      ? ".*"
      : char === "^"
        ? "(?:[^\\w.%-]|$)"
        : char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
  ).join("");

const TRACKER = new RegExp(Arr.map(EasyPrivacy.rules, ruleSource).join("|"), "i");

/** An image or CSS resource at this URL is an email tracker. */
export const isTrackerUrl = (url: URL): boolean => TRACKER.test(url.href);

/**
 * Click-tracking parameters Brave's list leaves out, ours (curated): campaign tags (`utm_*` is
 * matched by prefix) and the click ids of Mailchimp, Marketo, HubSpot, Google Ads, LinkedIn and
 * Kit. Brave skips `utm_*` because it rarely identifies a person; in a newsletter link it names
 * the mailing at least.
 */
const OWN_PARAMETERS = HashSet.make(
  "mc_cid",
  "mkt_tok",
  "_hsmi",
  "gclsrc",
  "gbraid",
  "li_fat_id",
  "ck_subscriber_id",
);

/** Any host, one host, or a host and its subdomains: the patterns the refresh script allows. */
const hostMatcher = (pattern: string) => {
  const host = pattern.slice("*://".length, -"/*".length);
  if (host === "*") return () => true;
  const isWildcard = host.startsWith("*.");
  const domain = isWildcard ? host.slice(2) : host;
  return (hostname: string) =>
    hostname === domain || (isWildcard && hostname.endsWith(`.${domain}`));
};

const BRAVE_GROUPS = Arr.map(Brave.groups, (group) => ({
  matches: Arr.map(group.include, hostMatcher),
  params: HashSet.fromIterable(Arr.map(group.params, (param) => param.toLowerCase())),
}));

/** `name` (lowercased) is a click-tracking parameter in links to `hostname`. */
export const isTrackingParameter = (hostname: string, name: string): boolean =>
  name.startsWith("utm_") ||
  HashSet.has(OWN_PARAMETERS, name) ||
  Arr.some(
    BRAVE_GROUPS,
    (group) =>
      HashSet.has(group.params, name) && Arr.some(group.matches, (matches) => matches(hostname)),
  );
