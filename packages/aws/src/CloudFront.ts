import { ClientAddress } from "@alias/core";
import * as Option from "effect/Option";

/**
 * What CloudFront adds to the requests it forwards to a function URL origin (PLAN.md §20.26).
 * https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-cloudfront-headers.html
 */

/**
 * The viewer's IP address and source port, e.g. `198.51.100.10:46532`. Only an origin request
 * policy can add it (not a cache policy); the managed `AllViewerExceptHostHeader` policy, the one
 * for function URL origins, includes the viewer location headers it belongs to.
 */
export const VIEWER_ADDRESS_HEADER = "cloudfront-viewer-address";

/**
 * Our origin custom header (`OriginSecret` in `@alias/core`). CloudFront overwrites a header of
 * the same name that the viewer sent ("Add custom headers to origin requests"), so only
 * CloudFront can put the secret there.
 */
export const ORIGIN_SECRET_HEADER = "x-alias-origin-secret";

const PORT = /^\d{1,5}$/;

/**
 * The address in a `CloudFront-Viewer-Address` value. The docs show IPv4 only; IPv6 viewers'
 * addresses come without brackets (`2001:db8::1:46532`), so the port is what follows the last
 * colon. Brackets are accepted too. Anything else, including several comma-joined values, is
 * refused.
 */
export const viewerAddress = (value: string): Option.Option<ClientAddress.ClientAddress> => {
  const colon = value.lastIndexOf(":");
  const port = value.slice(colon + 1);
  if (colon === -1 || !PORT.test(port) || Number(port) > 65_535) return Option.none();
  const host = value.slice(0, colon);
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return ClientAddress.parse(bare);
};
