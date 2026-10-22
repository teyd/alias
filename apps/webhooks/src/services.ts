import { MessageQueue } from "@alias/aws";
import { Dynamo } from "@alias/db";
import { Delivery, Egress, UrlPolicy } from "@alias/webhooks";
import { NodeCrypto } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";

/**
 * Everything the delivery Lambda needs, from its environment: `ALIAS_TABLE_NAME`,
 * `ALIAS_WEBHOOK_QUEUE_URL` (for backoff) and the AWS-standard endpoint overrides that only
 * emulated runs set. `ALIAS_WEBHOOK_ALLOW_LOOPBACK` exists for dev and tests; production never
 * sets it.
 */
export const ServicesConfig = Config.all([
  Dynamo.config,
  MessageQueue.config("ALIAS_WEBHOOK_QUEUE_URL"),
  UrlPolicy.config,
]).pipe(
  Config.map(([database, queue, policy]) =>
    Delivery.layer(
      Layer.mergeAll(database, queue, Delivery.production, NodeCrypto.layer, Egress.layer).pipe(
        Layer.provideMerge(policy),
      ),
    ),
  ),
);
