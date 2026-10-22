import { Parameters } from "@alias/aws";
import { NodeCrypto } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as Egress from "./Egress.ts";
import { ProxyKeys } from "./Proxy.ts";

/**
 * The image proxy Lambda's environment: `ALIAS_IMAGE_PROXY_KEYS_PARAMETER` (the SSM parameter
 * with the keys the inbound Lambda signs with), and `AWS_ENDPOINT_URL_SSM` only in emulated runs.
 * Egress is always the public internet. A bad value fails the cold start.
 */
export const ServicesConfig = Parameters.keyringConfig("ALIAS_IMAGE_PROXY_KEYS_PARAMETER").pipe(
  Config.map((keys) =>
    Layer.mergeAll(Layer.effect(ProxyKeys, keys), Egress.publicInternet, NodeCrypto.layer),
  ),
);
