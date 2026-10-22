import { AwsClient, SnsEvent } from "@alias/aws";
import notification from "@alias/aws/fixtures/sns-http-notification.json" with { type: "json" };
import documented from "@alias/aws/fixtures/sns-lambda-event.json" with { type: "json" };
import { FakeCloud } from "@alias/aws-emulators";
import * as SNS from "@distilled.cloud/aws/sns";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";
import * as Queue from "effect/Queue";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { SnsSubscriber } from "../src/index.ts";

/** The documented HTTP notification, parsed with the emulator's own schema. */
const delivered = Schema.decodeUnknownSync(SnsSubscriber.HttpNotification)(notification);

const subscriptionArn =
  "arn:aws:sns:us-west-2:123456789012:MyTopic:c9135db0-26c4-47ec-8998-413945fb5a96";

describe("SnsSubscriber.toEvent (contract: AWS documentation payloads)", () => {
  it.effect("turns the documented HTTP notification into an event production decodes", () =>
    Effect.gen(function* () {
      const event = SnsSubscriber.toEvent(delivered, subscriptionArn);
      const decoded = yield* SnsEvent.decode(event);
      expect(decoded.Records[0]).toMatchObject({
        EventSource: "aws:sns",
        EventSubscriptionArn: subscriptionArn,
        Sns: {
          Type: "Notification",
          MessageId: notification.MessageId,
          TopicArn: notification.TopicArn,
          Message: notification.Message,
          Timestamp: notification.Timestamp,
        },
      });
    }),
  );

  it("has exactly the fields of the documented Lambda event", () => {
    const [record] = SnsSubscriber.toEvent(delivered, subscriptionArn).Records;
    const [sample] = documented.Records;
    const keys = (value: Readonly<Record<string, Schema.Json>>) =>
      Arr.sort(R.keys(value), Order.String);
    expect(keys(record ?? {})).toEqual(keys(sample ?? {}));
    expect(keys(record?.Sns ?? {})).toEqual(keys(sample?.Sns ?? {}));
    expect(record?.Sns.UnsubscribeUrl).toBe(notification.UnsubscribeURL);
    expect(record?.Sns.SigningCertURL).toBe(notification.SigningCertURL);
    expect(record?.Sns.Subject).toBe("My First Message");
  });
});

const aws = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), ({ url }) => AwsClient.emulator(url)),
);

describe("SnsSubscriber on fakecloud", () => {
  it.layer(aws.pipe(Layer.provideMerge(FakeCloud.layer())), { timeout: 30_000 })((it) => {
    it.effect("confirms its subscription and hands each notification over as a Lambda event", () =>
      Effect.gen(function* () {
        const { TopicArn = "" } = yield* SNS.createTopic({ Name: "events" });
        const subscriber = yield* SnsSubscriber.make({ topicArn: TopicArn });
        const attributes = yield* SNS.getSubscriptionAttributes({
          SubscriptionArn: subscriber.subscriptionArn,
        });
        expect(attributes.Attributes?.["PendingConfirmation"]).toBe("false");

        yield* SNS.publish({ TopicArn, Message: '{"hello":"world"}', Subject: "Greeting" });
        const event = yield* Queue.take(subscriber.events);
        const decoded = yield* SnsEvent.decode(JSON.parse(JSON.stringify(event)));
        expect(decoded.Records[0]).toMatchObject({
          EventSubscriptionArn: subscriber.subscriptionArn,
          Sns: { TopicArn, Message: '{"hello":"world"}' },
        });
        expect(event.Records[0]?.Sns.Subject).toBe("Greeting");
      }).pipe(Effect.scoped),
    );
  });
});
