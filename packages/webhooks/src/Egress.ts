import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import { WebhookUrl } from "@alias/core";
import { NodeHttpClient } from "@effect/platform-node";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { UrlPolicy } from "./UrlPolicy.ts";

/**
 * The HTTP client deliveries go out through. `WebhookUrl.check` vets the URL itself; this checks
 * where its name resolves, at the moment of connecting: every address DNS returns must be allowed
 * (`WebhookUrl.isAllowedAddress`), and the socket connects to exactly those addresses. A name
 * that resolves to a private address, or rebinds to one after the URL check, fails the connect.
 * Redirects are never followed (Undici's `request` doesn't, and Effect's client follows only on
 * request), so a public endpoint can't bounce a delivery inward either.
 *
 * Node's resolver and socket hook live here and nowhere else (lint exemption in `vite.config.ts`).
 */

class BlockedAddress extends Schema.TaggedError<BlockedAddress>()("BlockedAddress", {
  hostname: Schema.String,
}) {}

const guardedLookup =
  (options: WebhookUrl.Options): LookupFunction =>
  (hostname, lookupOptions: LookupOptions, callback) => {
    dnsLookup(
      hostname,
      { ...lookupOptions, all: true },
      (error, addresses: Array<LookupAddress>) => {
        if (error !== null) return callback(error, "", 4);
        if (
          Arr.isArrayEmpty(addresses) ||
          !Arr.every(addresses, (entry) => WebhookUrl.isAllowedAddress(entry.address, options))
        ) {
          return callback(new BlockedAddress({ hostname }), "", 4);
        }
        if (lookupOptions.all === true) return callback(null, addresses);
        const [first] = addresses;
        return callback(null, first?.address ?? "", first?.family ?? 4);
      },
    );
  };

/** An Undici-backed `HttpClient` that connects only to addresses the `UrlPolicy` allows. */
export const layer = Layer.unwrap(
  Effect.map(UrlPolicy, (options) =>
    NodeHttpClient.layerUndiciOptions({ connect: { lookup: guardedLookup(options) } }),
  ),
);
