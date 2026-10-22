import { Parameters } from "@alias/aws";
import { Dynamo, ProxyRepo } from "@alias/db";
import { NodeCrypto } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as Egress from "./Egress.ts";
import { defaultBudgets, ProxyKeys } from "./Proxy.ts";

/**
 * The image proxy Lambda's environment: `ALIAS_IMAGE_PROXY_KEYS_PARAMETER` (the SSM parameter
 * with the keys the inbound Lambda signs with), `ALIAS_TABLE_NAME` (the fetch budgets, PLAN.md
 * §20.29), and `AWS_ENDPOINT_URL_SSM` and `AWS_ENDPOINT_URL_DYNAMODB` only in emulated runs.
 * Egress is always the public internet. A bad value fails the cold start.
 */
export const ServicesConfig = Config.all({
  keys: Parameters.keyringConfig("ALIAS_IMAGE_PROXY_KEYS_PARAMETER"),
  database: Dynamo.config,
}).pipe(
  Config.map(({ keys, database }) =>
    Layer.mergeAll(
      Layer.effect(ProxyKeys, keys),
      ProxyRepo.layer.pipe(Layer.provide(database)),
      defaultBudgets,
      Egress.publicInternet,
      NodeCrypto.layer,
    ),
  ),
);
