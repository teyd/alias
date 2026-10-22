import { MessageQueue } from "@alias/aws";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { SCHEDULE } from "./Delivery.ts";

/**
 * The webhook queue's shape, for infra and dev: one receive per attempt before the dead-letter
 * queue, and a visibility timeout of 180 s, six times the delivery Lambda's 30 s timeout, as the
 * Lambda SQS documentation recommends.
 */
export const settings = {
  maxReceiveCount: SCHEDULE.length + 1,
  visibilityTimeoutSeconds: 180,
} as const;

/** The dev queue every `bin/dev.ts` uses. */
export const devName = "alias-webhooks";

/**
 * `MessageQueue` on the dev queue, created like infra's if missing. Whichever dev process starts
 * first creates it; retried while fakecloud starts alongside. Dev only.
 */
export const dev = Layer.unwrap(
  MessageQueue.ensure(devName, settings).pipe(
    Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
    Effect.map(({ queueUrl }) => MessageQueue.layer(queueUrl)),
  ),
);
