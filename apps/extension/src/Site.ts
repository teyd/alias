import * as Option from "effect/Option";
import { parse } from "tldts";

/** The site a page belongs to, as an alias would be named after it. */
export interface Site {
  /** The registrable domain (`example.co.uk` for `shop.example.co.uk`). */
  readonly domain: string;
  /**
   * The domain without its public suffix: `example`. One DNS label (at most 63 letters, digits
   * and inner hyphens), so always a valid local part.
   */
  readonly localPart: string;
}

/**
 * The site of a web page's URL, by the Public Suffix List (private suffixes included, so
 * `ada.github.io` is a site of its own, not `github`). Nothing for other schemes (`chrome:`,
 * `about:`, `file:`), IP addresses and hosts without a registrable domain (`localhost`).
 */
export const fromUrl = (url: string): Option.Option<Site> => {
  if (!URL.canParse(url)) return Option.none();
  const { protocol, hostname } = new URL(url);
  if (protocol !== "https:" && protocol !== "http:") return Option.none();
  const parsed = parse(hostname, { allowPrivateDomains: true });
  if (parsed.isIp === true) return Option.none();
  return Option.flatMap(Option.fromNullishOr(parsed.domain), (domain) =>
    Option.map(
      Option.filter(Option.fromNullishOr(parsed.domainWithoutSuffix), (label) => label !== ""),
      (label) => ({
        domain,
        localPart: label.toLowerCase(),
      }),
    ),
  );
};
