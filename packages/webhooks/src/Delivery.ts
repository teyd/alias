import { MessageQueue, type SqsEvent } from "@alias/aws";
import { WebhookEvent } from "@alias/contracts";
import { Webhook, WebhookUrl } from "@alias/core";
import { type Dynamo, WebhookRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Random from "effect/Random";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { JobJson } from "./Job.ts";
import { UrlPolicy } from "./UrlPolicy.ts";

/**
 * The delivery Lambda's work (PLAN.md §20.20): for each SQS record, sign the event with the
 * endpoint's secret(s) (Standard Webhooks) and POST it.
 *
 * - `2xx` is delivered. `410 Gone` disables the endpoint, as the spec asks, and stops.
 * - Anything else (another status, a timeout, a refused or blocked connection) is retried:
 *   the record's next visibility is pushed out along {@link Settings.retryDelay} and it is
 *   reported in `batchItemFailures`. After the queue's `maxReceiveCount` receives, SQS moves it
 *   to the dead-letter queue.
 * - A record that can't be read, or whose endpoint is gone, paused, unsubscribed or no longer
 *   passes `WebhookUrl.check`, is dropped: retrying can't change that.
 */

export interface Settings {
  /** How long to wait before attempt `n + 1`, after attempt `n` (1-based) failed. */
  readonly retryDelay: (attempt: number) => Duration.Duration;
  /** Per request; the spec recommends 15 to 30 seconds. */
  readonly timeout: Duration.Duration;
}

export class DeliverySettings extends Context.Service<DeliverySettings, Settings>()(
  "@alias/webhooks/DeliverySettings",
) {}

/**
 * Exponential, spanning a day and a bit, as the spec recommends: 5 s, 5 min, 30 min, 2 h, 5 h,
 * 10 h, 10 h (the schedule Svix, the spec's authors, publish), each ±20 % so retries don't
 * arrive in lockstep. Eight attempts in all: the queue's `maxReceiveCount` (`Queue.ts`).
 */
export const SCHEDULE = [
  Duration.seconds(5),
  Duration.minutes(5),
  Duration.minutes(30),
  Duration.hours(2),
  Duration.hours(5),
  Duration.hours(10),
  Duration.hours(10),
];

const productionSchedule = (attempt: number): Duration.Duration =>
  Option.getOrElse(Arr.get(SCHEDULE, attempt - 1), () => Duration.hours(10));

/** How long a rotated-out secret keeps signing. */
export const ROTATION_GRACE = Duration.hours(24);

type Outcome =
  | { readonly _tag: "Delivered"; readonly status: number }
  | { readonly _tag: "Dropped"; readonly reason: string }
  | { readonly _tag: "Retry"; readonly reason: string };

const delivered = (status: number): Outcome => ({ _tag: "Delivered", status });
const dropped = (reason: string): Outcome => ({ _tag: "Dropped", reason });
const retry = (reason: string): Outcome => ({ _tag: "Retry", reason });
const isRetry = P.isTagged("Retry");

const decodeJob = Schema.decodeUnknownEffect(JobJson);
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(WebhookEvent));

const attempt = Effect.fn("Delivery.attempt")(function* (record: SqsEvent.SqsRecord) {
  const settings = yield* DeliverySettings;
  const policy = yield* UrlPolicy;
  const webhooks = yield* WebhookRepo.WebhookRepo;
  const client = yield* HttpClient.HttpClient;

  const job = yield* Effect.option(decodeJob(record.body));
  if (Option.isNone(job)) return dropped("unreadable");
  const found = yield* Effect.result(webhooks.find(job.value.userId, job.value.webhookId));
  if (Result.isFailure(found)) return retry("database");
  if (Option.isNone(found.success)) return dropped("endpoint-gone");
  const endpoint = found.success.value;
  if (!endpoint.isEnabled) return dropped("endpoint-disabled");
  if (!Arr.contains(endpoint.eventTypes, job.value.event.type)) return dropped("unsubscribed");
  const url = WebhookUrl.check(endpoint.url, policy);
  if (Result.isFailure(url)) return dropped(`url-${url.failure}`);

  const now = yield* DateTime.now;
  const secrets = Arr.getSomes([
    Webhook.secretKey(endpoint.secret),
    Option.flatMap(
      Option.filter(endpoint.previousSecretUntil, (until) => DateTime.isGreaterThan(until, now)),
      () => Option.flatMap(endpoint.previousSecret, Webhook.secretKey),
    ),
  ]);
  const body = yield* Effect.orDie(encodeEvent(job.value.event));
  const timestamp = Math.floor(DateTime.toEpochMillis(now) / 1000);
  const signature = yield* Effect.orDie(
    Webhook.sign({ secrets, id: job.value.id, timestamp, body }),
  );
  const request = HttpClientRequest.post(url.success).pipe(
    HttpClientRequest.setHeaders({
      "content-type": "application/json",
      "user-agent": "Alias-Webhooks/1",
      "webhook-id": job.value.id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
    }),
    HttpClientRequest.bodyText(body, "application/json"),
  );
  // Only the status matters; the body is never read, and the scope aborts the request.
  const status = yield* HttpClient.withScope(client)
    .execute(request)
    .pipe(
      Effect.map((response) => response.status),
      Effect.scoped,
      Effect.timeout(settings.timeout),
      Effect.option,
    );
  if (Option.isNone(status)) return retry("unreachable");
  if (status.value >= 200 && status.value < 300) return delivered(status.value);
  if (status.value === 410) {
    yield* webhooks
      .update(job.value.userId, job.value.webhookId, { isEnabled: false })
      .pipe(Effect.ignore);
    return dropped("gone");
  }
  return retry(`status-${status.value}`);
});

/** A failed record's next attempt waits {@link Settings.retryDelay}, ±20 %. */
const backOff = Effect.fn("Delivery.backOff")(function* (record: SqsEvent.SqsRecord) {
  const settings = yield* DeliverySettings;
  const queue = yield* MessageQueue.MessageQueue;
  const base = Duration.toMillis(settings.retryDelay(record.attributes.ApproximateReceiveCount));
  const jitter = 0.8 + (yield* Random.next) * 0.4;
  yield* queue
    .retryIn(record.receiptHandle, Duration.millis(Math.round(base * jitter)))
    .pipe(
      Effect.catchTag("QueueUnavailable", (error) =>
        Effect.logWarning("webhook backoff not set; the queue's visibility timeout applies", error),
      ),
    );
});

const processRecord = Effect.fn("Delivery.processRecord")(
  function* (record: SqsEvent.SqsRecord) {
    const outcome = yield* attempt(record);
    yield* Effect.logInfo(`webhook ${outcome._tag.toLowerCase()}`, outcome);
    if (!isRetry(outcome)) return Option.none<string>();
    yield* backOff(record);
    return Option.some(record.messageId);
  },
  (effect, record) =>
    Effect.annotateLogs(effect, {
      sqsMessageId: record.messageId,
      attempt: record.attributes.ApproximateReceiveCount,
    }),
);

/**
 * The delivery Lambda's work on an event parsed with `SqsEvent.decode`. Never fails: every
 * record's fate is in the batch response (the mapping has `ReportBatchItemFailures` on).
 */
export const handle = Effect.fn("Delivery.handle")(function* (event: SqsEvent.SqsEvent) {
  const failed = yield* Effect.forEach(event.Records, processRecord, { concurrency: 10 });
  const response: SqsEvent.BatchResponse = {
    batchItemFailures: Arr.map(Arr.getSomes(failed), (itemIdentifier) => ({ itemIdentifier })),
  };
  return response;
});

/**
 * The delivery Lambda's settings: production's schedule and a 15 s timeout (the spec's lower
 * bound, which keeps a batch of ten well inside the Lambda timeout).
 */
export const production = Layer.succeed(DeliverySettings, {
  retryDelay: productionSchedule,
  timeout: Duration.seconds(15),
});

/** What callers provide: the table, the queue (for backoff), settings and the egress client. */
export type Services =
  | Dynamo.Database
  | MessageQueue.MessageQueue
  | DeliverySettings
  | UrlPolicy
  | HttpClient.HttpClient
  | Crypto.Crypto;

export const layer = <E, R>(services: Layer.Layer<Services, E, R>) =>
  WebhookRepo.layer.pipe(Layer.provideMerge(services));
