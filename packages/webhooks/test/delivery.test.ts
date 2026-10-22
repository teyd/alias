import { AwsClient, MessageQueue, SqsEvent } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { WebhookEvent } from "@alias/contracts";
import { Webhook } from "@alias/core";
import { WebhookRepo } from "@alias/db";
import { freshTable } from "@alias/db/testing";
import { SqsEventSource } from "@alias/lambda-emulator";
import * as SQS from "@distilled.cloud/aws/sqs";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Delivery, Egress, Publisher, UrlPolicy } from "../src/index.ts";
import { Receiver, TestQueue, freshQueue } from "./support/index.ts";

const loopback = { isLoopbackAllowed: true };

/** Retries after 0.5 s ±20 %, which SQS rounds up to 1 s, so a backed-off message comes back quickly. */
const settings = () =>
  Layer.succeed(Delivery.DeliverySettings, {
    retryDelay: () => Duration.millis(500),
    timeout: Duration.seconds(5),
  });

/** One test's world: a table, a webhook queue, the publisher and the delivery Lambda's services. */
const world = (maxReceiveCount = 8, url = loopback) =>
  Layer.mergeAll(Publisher.layer, WebhookRepo.layer, settings(), Egress.layer).pipe(
    Layer.provideMerge(UrlPolicy.layer(url)),
    Layer.provideMerge(Layer.mergeAll(freshTable(), freshQueue(maxReceiveCount), NodeCrypto.layer)),
  );

/** Registers an endpoint for usr_1 and returns its secret. */
const register = Effect.fn("register")(function* (
  url: string,
  eventTypes: ReadonlyArray<string> = ["alias.created", "mail.forwarded"],
  id = "wh_1",
) {
  const secret = yield* Webhook.newSecret();
  const repo = yield* WebhookRepo.WebhookRepo;
  yield* repo.create({
    id,
    userId: "usr_1",
    url,
    eventTypes,
    secret,
    createdAt: yield* DateTime.now,
  });
  return secret;
});

/** The delivery Lambda behind an emulated event source mapping on the test queue. */
const lambda = Effect.fn("lambda")(function* () {
  const { queueUrl } = yield* TestQueue;
  const services = yield* Effect.context<
    | WebhookRepo.WebhookRepo
    | Delivery.DeliverySettings
    | UrlPolicy.UrlPolicy
    | HttpClient.HttpClient
    | Crypto.Crypto
    | MessageQueue.MessageQueue
  >();
  return yield* SqsEventSource.make({
    queueUrl,
    handler: (event) =>
      SqsEvent.decode(event).pipe(Effect.flatMap(Delivery.handle), Effect.provide(services)),
  });
});

const created = (address = "shop@ada.alias.test"): WebhookEvent => ({
  type: "alias.created",
  timestamp: "2026-10-22T09:00:00.000Z",
  data: { aliasId: "al_1", address, origin: "api" },
});

/** The delivery's clock (the test clock), as receivers compare `webhook-timestamp` with theirs. */
const nowSeconds = Effect.map(DateTime.now, (now) =>
  Math.floor(DateTime.toEpochMillis(now) / 1000),
);

const sleep = (millis: number) =>
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, millis)));

const aws = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), ({ url }) => AwsClient.emulator(url)),
);

describe("webhook delivery (Publisher → SQS on fakecloud → event source → Delivery)", () => {
  it.layer(aws.pipe(Layer.provideMerge(FakeCloud.layer())), { timeout: 30_000 })((it) => {
    it.effect("signs and posts an event to every subscribed endpoint, once", () =>
      Effect.gen(function* () {
        const receiver = yield* Receiver.make();
        const secret = yield* register(receiver.url);
        yield* register(receiver.url, ["mail.forwarded"], "wh_2");
        const publisher = yield* Publisher.Publisher;
        yield* publisher.publish("usr_1", created(), "al_1");
        const source = yield* lambda();

        expect(yield* source.poll).toEqual({ received: 1, deleted: 1 });
        const [request] = receiver.received;
        expect(receiver.received).toHaveLength(1);
        expect(request?.headers["content-type"]).toBe("application/json");
        expect(request?.headers["webhook-id"]).toMatch(/^msg_[0-9a-f]{32}$/);
        const isValid = yield* Webhook.verify({
          secret,
          id: request?.headers["webhook-id"] ?? "",
          timestamp: Number(request?.headers["webhook-timestamp"]),
          signature: request?.headers["webhook-signature"] ?? "",
          body: request?.body ?? "",
          nowSeconds: yield* nowSeconds,
        });
        expect(isValid).toBe(true);
        expect(
          Schema.decodeUnknownSync(Schema.fromJsonString(WebhookEvent))(request?.body),
        ).toEqual(created());
        expect(yield* source.poll).toEqual({ received: 0, deleted: 0 });
      }).pipe(Effect.provide(world())),
    );

    it.effect("queues nothing for paused or unsubscribed endpoints, or users without any", () =>
      Effect.gen(function* () {
        const receiver = yield* Receiver.make();
        yield* register(receiver.url, ["mail.forwarded"]);
        yield* register(receiver.url, ["alias.created"], "wh_2");
        const repo = yield* WebhookRepo.WebhookRepo;
        yield* repo.update("usr_1", "wh_2", { isEnabled: false });
        const publisher = yield* Publisher.Publisher;
        yield* publisher.publish("usr_1", created(), "al_1");
        yield* publisher.publish("usr_2", created(), "al_2");
        const { queueUrl } = yield* TestQueue;
        const { Attributes } = yield* SQS.getQueueAttributes({
          QueueUrl: queueUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        });
        expect(Attributes?.ApproximateNumberOfMessages).toBe("0");
      }).pipe(Effect.provide(world())),
    );

    it.effect("retries a failed delivery after the backoff, with the same webhook-id", () =>
      Effect.gen(function* () {
        const receiver = yield* Receiver.make([500, 200]);
        yield* register(receiver.url);
        yield* (yield* Publisher.Publisher).publish("usr_1", created(), "al_1");
        const source = yield* lambda();

        expect(yield* source.poll).toEqual({ received: 1, deleted: 0 });
        // Backed off (≈1 s here), not redelivered at once.
        expect(yield* source.poll).toEqual({ received: 0, deleted: 0 });
        yield* sleep(1_400);
        expect(yield* source.poll).toEqual({ received: 1, deleted: 1 });
        const ids = Arr.map(receiver.received, (request) => request.headers["webhook-id"]);
        expect(ids).toHaveLength(2);
        expect(ids[0]).toBe(ids[1]);
      }).pipe(Effect.provide(world())),
    );

    it.effect("never follows a redirect, and gives up to the dead-letter queue", () =>
      Effect.gen(function* () {
        const receiver = yield* Receiver.make([302]);
        yield* register(receiver.url);
        yield* (yield* Publisher.Publisher).publish("usr_1", created(), "al_1");
        const source = yield* lambda();

        expect(yield* source.poll).toEqual({ received: 1, deleted: 0 });
        yield* sleep(1_400);
        expect(yield* source.poll).toEqual({ received: 1, deleted: 0 });
        yield* sleep(1_400);
        // Past maxReceiveCount (2 here): SQS moves it to the dead-letter queue.
        expect(yield* source.poll).toEqual({ received: 0, deleted: 0 });
        expect(Arr.map(receiver.received, (request) => request.path)).toEqual(["/hook", "/hook"]);
        const { dlqUrl } = yield* TestQueue;
        const dead = yield* SQS.receiveMessage({ QueueUrl: dlqUrl });
        expect(dead.Messages ?? []).toHaveLength(1);
      }).pipe(Effect.provide(world(2))),
    );

    it.effect("disables an endpoint that answers 410 Gone", () =>
      Effect.gen(function* () {
        const receiver = yield* Receiver.make([410]);
        yield* register(receiver.url);
        yield* (yield* Publisher.Publisher).publish("usr_1", created(), "al_1");
        expect(yield* (yield* lambda()).poll).toEqual({ received: 1, deleted: 1 });
        const repo = yield* WebhookRepo.WebhookRepo;
        expect(
          Option.map(yield* repo.find("usr_1", "wh_1"), (webhook) => webhook.isEnabled),
        ).toEqual(Option.some(false));
        // Later events skip it.
        yield* (yield* Publisher.Publisher).publish("usr_1", created(), "al_2");
        expect(yield* (yield* lambda()).poll).toEqual({ received: 0, deleted: 0 });
      }).pipe(Effect.provide(world())),
    );

    it.effect("retries an endpoint that isn't listening", () =>
      Effect.gen(function* () {
        const receiver = yield* Receiver.make();
        receiver.close();
        yield* register(receiver.url);
        yield* (yield* Publisher.Publisher).publish("usr_1", created(), "al_1");
        expect(yield* (yield* lambda()).poll).toEqual({ received: 1, deleted: 0 });
      }).pipe(Effect.provide(world())),
    );

    it.effect("signs with the old secret too for a day after a rotation", () =>
      Effect.gen(function* () {
        const receiver = yield* Receiver.make();
        const old = yield* register(receiver.url);
        const fresh = yield* Webhook.newSecret();
        const repo = yield* WebhookRepo.WebhookRepo;
        const until = DateTime.addDuration(yield* DateTime.now, Delivery.ROTATION_GRACE);
        yield* repo.rotateSecret("usr_1", "wh_1", fresh, until);
        yield* (yield* Publisher.Publisher).publish("usr_1", created(), "al_1");
        yield* (yield* lambda()).poll;
        const [request] = receiver.received;
        const now = yield* nowSeconds;
        const check = (secret: string) =>
          Webhook.verify({
            secret,
            id: request?.headers["webhook-id"] ?? "",
            timestamp: Number(request?.headers["webhook-timestamp"]),
            signature: request?.headers["webhook-signature"] ?? "",
            body: request?.body ?? "",
            nowSeconds: now,
          });
        expect(request?.headers["webhook-signature"]?.split(" ")).toHaveLength(2);
        expect(yield* check(old)).toBe(true);
        expect(yield* check(fresh)).toBe(true);
      }).pipe(Effect.provide(world())),
    );

    it.effect("drops deliveries to URLs production refuses, even if stored", () =>
      Effect.gen(function* () {
        const receiver = yield* Receiver.make();
        yield* register(receiver.url);
        yield* (yield* Publisher.Publisher).publish("usr_1", created(), "al_1");
        expect(yield* (yield* lambda()).poll).toEqual({ received: 1, deleted: 1 });
        expect(receiver.received).toEqual([]);
      }).pipe(Effect.provide(world(8, { isLoopbackAllowed: false }))),
    );
  });
});

describe("Egress", () => {
  it.effect("connects to a name only when every address it resolves to is allowed", () =>
    Effect.gen(function* () {
      const receiver = yield* Receiver.make();
      // `localhost` resolves from the hosts file, no network: to loopback.
      const url = receiver.url.replace("127.0.0.1", "localhost");
      const status = (isLoopbackAllowed: boolean) =>
        HttpClient.get(url).pipe(
          Effect.map((response) => response.status),
          Effect.scoped,
          Effect.option,
          Effect.provide(Egress.layer.pipe(Layer.provide(UrlPolicy.layer({ isLoopbackAllowed })))),
        );
      expect(yield* status(true)).toEqual(Option.some(200));
      expect(yield* status(false)).toEqual(Option.none());
      expect(receiver.received).toHaveLength(1);
    }),
  );
});
