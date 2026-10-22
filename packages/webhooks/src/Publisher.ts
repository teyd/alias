import { MessageQueue } from "@alias/aws";
import type { WebhookEvent } from "@alias/contracts";
import { WebhookRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { JobJson } from "./Job.ts";

/**
 * Where the Lambdas report what happened: one SQS message per event and subscribed endpoint,
 * which the delivery Lambda signs and posts (`Delivery.ts`).
 *
 * Best effort by design: a failure to list endpoints or enqueue is logged, never returned, so a
 * webhook problem can't fail a forward, an API call or a bounce. Lambda retries of the producer
 * may publish an event twice; both copies carry the same `webhook-id`, derived from `key`.
 */
export class Publisher extends Context.Service<
  Publisher,
  {
    /**
     * `key` names the event uniquely and stably (for example the SES message ID, recipient and
     * type), so a retried producer yields the same `webhook-id`.
     */
    readonly publish: (userId: string, event: WebhookEvent, key: string) => Effect.Effect<void>;
  }
>()("@alias/webhooks/Publisher") {}

const encodeJob = Schema.encodeEffect(JobJson);

const make = Effect.fn("Publisher.make")(function* () {
  const crypto = yield* Crypto.Crypto;
  const webhooks = yield* WebhookRepo.WebhookRepo;
  const queue = yield* MessageQueue.MessageQueue;

  /** `msg_` and 128 bits of the key's SHA-256. */
  const messageId = (key: string) =>
    Effect.map(
      crypto.digest("SHA-256", new TextEncoder().encode(key)),
      (digest) => `msg_${Hex.encode(digest).slice(0, 32)}`,
    );

  const publish = Effect.fn("Publisher.publish")(function* (
    userId: string,
    event: WebhookEvent,
    key: string,
  ) {
    const subscribed = Arr.filter(
      yield* webhooks.list(userId),
      (webhook) => webhook.isEnabled && Arr.contains(webhook.eventTypes, event.type),
    );
    if (Arr.isArrayEmpty(subscribed)) return;
    const id = yield* messageId(`${event.type}:${key}`);
    const bodies = yield* Effect.forEach(
      subscribed,
      (webhook) => encodeJob({ id, userId, webhookId: webhook.id, event }),
      { concurrency: 1 },
    );
    yield* queue.send(bodies);
    yield* Effect.logInfo("webhook event queued", { type: event.type, endpoints: bodies.length });
  });

  return Publisher.of({
    publish: (userId, event, key) =>
      publish(userId, event, key).pipe(
        Effect.catch((error) =>
          Effect.logWarning("webhook event not queued", { type: event.type, error: error._tag }),
        ),
      ),
  });
});

export const layer = Layer.effect(Publisher, make()).pipe(Layer.provide(WebhookRepo.layer));
