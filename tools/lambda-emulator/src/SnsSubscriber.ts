import { createServer, type IncomingMessage } from "node:http";
import type { AwsClient } from "@alias/aws";
import * as SNS from "@distilled.cloud/aws/sns";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

/**
 * The last hop of SNS → Lambda: what Lambda's SNS integration hands a subscribed function.
 * fakecloud publishes to SNS topics and delivers to HTTP subscribers, but invokes Lambda only in
 * Docker, so this emulator subscribes to the topic over HTTP instead, as AWS documents for HTTP
 * endpoints, and turns each notification into the documented Lambda event:
 *
 * - HTTP notifications and subscription confirmations:
 *   https://docs.aws.amazon.com/sns/latest/dg/http-notification-json.html,
 *   https://docs.aws.amazon.com/sns/latest/dg/http-subscription-confirmation-json.html
 * - the Lambda event: https://docs.aws.amazon.com/lambda/latest/dg/with-sns.html
 *
 * It shares no code with the production schema (`@alias/aws` SnsEvent); contract tests pin both
 * to the documented payloads.
 */

/** An SNS notification as delivered to an HTTP endpoint. */
export const HttpNotification = Schema.Struct({
  Type: Schema.Literal("Notification"),
  MessageId: Schema.String,
  TopicArn: Schema.String,
  Subject: Schema.optionalKey(Schema.String),
  Message: Schema.String,
  Timestamp: Schema.String,
  SignatureVersion: Schema.String,
  Signature: Schema.String,
  SigningCertURL: Schema.String,
  UnsubscribeURL: Schema.String,
  MessageAttributes: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ Type: Schema.String, Value: Schema.String })),
  ),
});
export type HttpNotification = typeof HttpNotification.Type;

const SubscriptionConfirmation = Schema.Struct({
  Type: Schema.Literal("SubscriptionConfirmation"),
  SubscribeURL: Schema.String,
});

const decodeBody = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([HttpNotification, SubscriptionConfirmation])),
);

/**
 * The Lambda event for one notification, field for field as the Lambda documentation shows it.
 * The sample spells `SigningCertURL` but `UnsubscribeUrl`, unlike the HTTP format; the copy
 * follows it. An absent subject is `null`.
 */
export const toEvent = (notification: HttpNotification, subscriptionArn: string) => ({
  Records: [
    {
      EventVersion: "1.0",
      EventSubscriptionArn: subscriptionArn,
      EventSource: "aws:sns",
      Sns: {
        SignatureVersion: notification.SignatureVersion,
        Timestamp: notification.Timestamp,
        Signature: notification.Signature,
        SigningCertURL: notification.SigningCertURL,
        MessageId: notification.MessageId,
        Message: notification.Message,
        MessageAttributes: notification.MessageAttributes ?? {},
        Type: notification.Type,
        UnsubscribeUrl: notification.UnsubscribeURL,
        TopicArn: notification.TopicArn,
        Subject: notification.Subject ?? null,
      },
    },
  ],
});
export type SnsLambdaEvent = ReturnType<typeof toEvent>;

export class SubscriberFailure extends Schema.TaggedError<SubscriberFailure>()(
  "SubscriberFailure",
  { reason: Schema.String },
) {}

export interface SnsSubscriberConfig {
  readonly topicArn: string;
  readonly host?: string;
}

export class SnsSubscriber extends Context.Service<
  SnsSubscriber,
  {
    readonly url: string;
    readonly subscriptionArn: string;
    /** One Lambda event per notification, in arrival order. */
    readonly events: Queue.Dequeue<SnsLambdaEvent>;
  }
>()("@alias/lambda-emulator/SnsSubscriber") {}

const readBody = (request: IncomingMessage) =>
  Effect.callback<string, SubscriberFailure>((resume) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString("utf8"))));
    request.on("error", (error) =>
      resume(Effect.fail(new SubscriberFailure({ reason: error.message }))),
    );
  });

const decodeAddress = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }));

/** Subscribes to `topicArn` on whatever `AwsClient` points at (fakecloud), confirms, and serves. */
export const make = Effect.fn("SnsSubscriber.make")(function* (config: SnsSubscriberConfig) {
  const client = yield* Effect.context<AwsClient.AwsClient>();
  const events = yield* Queue.unbounded<SnsLambdaEvent>();
  const confirmed = yield* Deferred.make<void>();
  const host = config.host ?? "127.0.0.1";

  /** Answers one POST from SNS. Only a 2xx tells SNS the delivery succeeded. */
  const receive = Effect.fn("SnsSubscriber.receive")(function* (
    body: string,
    subscriptionArn: string,
  ) {
    const message = yield* decodeBody(body).pipe(
      Effect.mapError((error) => new SubscriberFailure({ reason: error.message })),
    );
    if (message.Type === "SubscriptionConfirmation") {
      // AWS: visit the SubscribeURL to confirm the subscription.
      yield* Effect.tryPromise({
        try: () => fetch(message.SubscribeURL).then((response) => response.status),
        catch: (cause) => new SubscriberFailure({ reason: String(cause) }),
      }).pipe(
        Effect.filterOrFail(
          (status) => status >= 200 && status < 300,
          (status) => new SubscriberFailure({ reason: `SubscribeURL answered ${status}` }),
        ),
      );
      yield* Deferred.succeed(confirmed, undefined);
      return;
    }
    yield* Queue.offer(events, toEvent(message, subscriptionArn));
  });

  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const server = createServer((request, response) => {
    const header = request.headers["x-amz-sns-subscription-arn"];
    const subscriptionArn = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
    void run(
      readBody(request).pipe(
        Effect.flatMap((body) => receive(body, subscriptionArn)),
        Effect.as(200),
        Effect.catchTag("SubscriberFailure", (error) =>
          Effect.as(Effect.logError("sns subscriber refused a delivery", error.reason), 400),
        ),
        Effect.flatMap((status) =>
          Effect.sync(() => {
            response.statusCode = status;
            response.end();
          }),
        ),
      ),
    );
  });

  const port = yield* Effect.acquireRelease(
    Effect.callback<number, SubscriberFailure>((resume) => {
      server.once("error", (error) =>
        resume(Effect.fail(new SubscriberFailure({ reason: error.message }))),
      );
      server.listen(0, host, () => {
        resume(
          decodeAddress(server.address()).pipe(
            Effect.map((address) => address.port),
            Effect.mapError(() => new SubscriberFailure({ reason: "server has no TCP address" })),
          ),
        );
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  const url = `http://${host}:${port}/`;

  // Unsubscribed when the scope closes, so a persistent topic (dev) never keeps posting to a
  // port nobody listens on any more.
  const subscribed = yield* Effect.acquireRelease(
    SNS.subscribe({
      TopicArn: config.topicArn,
      Protocol: "http",
      Endpoint: url,
      ReturnSubscriptionArn: true,
    }).pipe(
      Effect.mapError((error) => new SubscriberFailure({ reason: String(error) })),
      Effect.provide(client),
    ),
    (subscription) =>
      Option.match(Option.fromUndefinedOr(subscription.SubscriptionArn), {
        onNone: () => Effect.void,
        onSome: (arn) =>
          SNS.unsubscribe({ SubscriptionArn: arn }).pipe(Effect.ignore, Effect.provide(client)),
      }),
  );
  // SNS confirms over the network in real time, whatever clock a test runs under.
  yield* Deferred.await(confirmed).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(10),
      orElse: () => Effect.fail(new SubscriberFailure({ reason: "subscription never confirmed" })),
    }),
    Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
  );
  return SnsSubscriber.of({
    url,
    subscriptionArn: Option.getOrElse(Option.fromUndefinedOr(subscribed.SubscriptionArn), () =>
      Arr.join([config.topicArn, "unknown"], ":"),
    ),
    events,
  });
});
