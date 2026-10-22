import { MailSettings, RelyingParty, makeFunctionUrlHandler } from "@alias/api";
import {
  AwsClient,
  FunctionUrl,
  Identities,
  Inbound,
  type MessageQueue,
  Objects,
  Parameters,
  SesEvent,
  SqsEvent,
  Transport,
} from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { SharedDomains, TempDomains } from "@alias/core";
import { Dynamo } from "@alias/db";
import { freshTable } from "@alias/db/testing";
import { Doh } from "@alias/dns";
import { DohServer } from "@alias/doh-emulator";
import { Proxy } from "@alias/image-proxy";
import * as ImageProxyTesting from "@alias/image-proxy/testing";
import { Inbox } from "@alias/inbox";
import { Feedback, ImageProxySigner, Pipeline, ReverseKeys, Spool } from "@alias/inbound";
import { FunctionUrlServer, SnsSubscriber, SqsEventSource } from "@alias/lambda-emulator";
import { Delivery, Egress, Secrets, UrlPolicy } from "@alias/webhooks";
import { TestQueue, freshQueue } from "@alias/webhooks/testing";
import * as SESV2 from "@distilled.cloud/aws/sesv2";
import * as SNS from "@distilled.cloud/aws/sns";
import * as SSM from "@distilled.cloud/aws/ssm";
import { SesEmulator } from "@alias/ses-emulator";
import { NodeCrypto } from "@effect/platform-node";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { createTransport } from "nodemailer";

/**
 * The whole emulated stack, every listener on port 0:
 * - SMTP → SES emulator (receipt rules, verdicts) → S3 spool on fakecloud → SES Lambda event →
 *   the real inbound pipeline → SES sending on fakecloud;
 * - HTTP → function URL emulator → the real API Lambda handler → DynamoDB on fakecloud, SES
 *   identities on fakecloud, DNS checks through the DoH emulator;
 * - a proxied image in forwarded mail → function URL emulator → the image proxy Lambda → the
 *   sender's image host.
 * One fakecloud process serves S3, DynamoDB, SES, SNS and SSM, as one AWS account would, and every
 * Lambda shares one table. The stack test (`e2e`) and the browser tests (`browser`) both run it;
 * each brings its own API server, because the browser's needs the web app's origin.
 */
const aws = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), (fakecloud) => AwsClient.emulator(fakecloud.url)),
);
export const spoolBucket = "alias-spool";
const spool = Layer.effectDiscard(Inbound.ensureSpool(spoolBucket)).pipe(Layer.provide(aws));
const database = freshTable();
/** The webhook queue every producer publishes to and the delivery Lambda polls (PLAN.md §20.20). */
const webhookQueue = freshQueue();
/** Webhook receivers in this test listen on 127.0.0.1 over http, which production refuses. */
const urlPolicy = UrlPolicy.layer({ isLoopbackAllowed: true });
const sharedDomains = SharedDomains.layer("alias.test");
/** Every send names it; its SNS destination reports bounces and complaints (PLAN.md §20.11). */
const configurationSet = "alias-events";
const sending = Transport.layer({ configurationSet: Option.some(configurationSet) }).pipe(
  Layer.provide(aws),
);

/** The configuration set's SNS destination, and the feedback Lambda's subscription to it. */
const feedbackTopic = Layer.effect(
  SnsSubscriber.SnsSubscriber,
  Effect.gen(function* () {
    const { TopicArn = "" } = yield* SNS.createTopic({ Name: "ses-events" });
    yield* SESV2.createConfigurationSet({ ConfigurationSetName: configurationSet });
    yield* SESV2.createConfigurationSetEventDestination({
      ConfigurationSetName: configurationSet,
      EventDestinationName: "feedback",
      EventDestination: {
        Enabled: true,
        MatchingEventTypes: ["BOUNCE", "COMPLAINT"],
        SnsDestination: { TopicArn },
      },
    });
    return yield* SnsSubscriber.make({ topicArn: TopicArn });
  }),
).pipe(Layer.provide(aws));

/**
 * The inbox store (PLAN.md §20.22) as production runs it: its keys a SecureString in Parameter
 * Store, its bodies in their own bucket, on the shared table. The API and the inbound Lambda use
 * the same one, as both Lambdas would.
 */
export const inboxBucket = "alias-inbox";
const inboxKeysParameter = "/alias/e2e/inbox-keys";
const inboxStore = Layer.unwrap(
  Effect.gen(function* () {
    yield* SSM.putParameter({
      Name: inboxKeysParameter,
      Type: "SecureString",
      Value: `1:${Buffer.alloc(32, 13).toString("base64url")}`,
    });
    yield* Objects.ensureBucket(inboxBucket);
    const { url } = yield* FakeCloud.FakeCloud;
    return Inbox.fromConfig(
      {
        bucket: inboxBucket,
        endpoint: Option.some(url),
        keys: Parameters.keyring(inboxKeysParameter).pipe(Effect.provide(AwsClient.emulator(url))),
      },
      database,
    );
  }),
).pipe(Layer.provide(aws));
/**
 * The webhook keys (PLAN.md §20.30) as production reads them: a SecureString in Parameter Store,
 * read by the API (sealing endpoint secrets) and the delivery Lambda (opening them).
 */
const webhookKeysParameter = "/alias/e2e/webhook-keys";
const webhookKeys = Layer.unwrap(
  Effect.gen(function* () {
    yield* SSM.putParameter({
      Name: webhookKeysParameter,
      Type: "SecureString",
      Value: `1:${Buffer.alloc(32, 21).toString("base64url")}`,
      Overwrite: true,
    });
    const { url } = yield* FakeCloud.FakeCloud;
    return Layer.effect(
      Secrets.WebhookKeys,
      Parameters.keyring(webhookKeysParameter).pipe(Effect.provide(AwsClient.emulator(url))),
    );
  }),
).pipe(Layer.provide(aws));

/** Temporary inboxes live on their own registrable domain. */
const tempDomains = TempDomains.layer("tmp.test").pipe(Layer.provide(sharedDomains));

/**
 * The real API Lambda handler on the stack's table, queue and SES, for passkeys bound to
 * `relyingParty`. Serve it with `FunctionUrlServer`.
 */
export const apiHandler = Effect.fn("stack.apiHandler")(function* (relyingParty: {
  readonly id: string;
  readonly origin: string;
}) {
  const context = yield* Effect.context<Dynamo.Database>();
  const fakecloud = yield* FakeCloud.FakeCloud;
  const dns = yield* DohServer.DohServer;
  const { handle, dispose } = makeFunctionUrlHandler(
    Layer.mergeAll(
      Layer.succeedContext(context),
      Identities.layer.pipe(Layer.provide(AwsClient.emulator(fakecloud.url))),
      Doh.layer(dns.url),
      RelyingParty.layer(relyingParty),
      Transport.layer({ configurationSet: Option.some(configurationSet) }).pipe(
        Layer.provide(AwsClient.emulator(fakecloud.url)),
      ),
      MailSettings.layer(Option.some("no-reply@alias.test")).pipe(
        Layer.provideMerge(sharedDomains),
      ),
      Layer.succeedContext(yield* Effect.context<MessageQueue.MessageQueue>()),
      Layer.succeedContext(yield* Effect.context<Inbox.Inbox>()),
      Layer.succeedContext(yield* Effect.context<Secrets.WebhookKeys>()),
      tempDomains,
      urlPolicy,
      // The contexts above carry the test's clock; the Lambda runs in real time, which its long
      // poll (PLAN.md §20.22) sleeps on.
      Layer.succeed(Clock.Clock, yield* TestClock.withLive(Effect.clockWith(Effect.succeed))),
    ),
  );
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  return (event: FunctionUrl.FunctionUrlEvent) => Effect.runPromise(handle(event));
});

/** The reverse-token keys as production stores them: a SecureString in Parameter Store. */
const reverseKeysParameter = "/alias/e2e/reverse-token-keys";
const reverseKeys = Layer.unwrap(
  SSM.putParameter({
    Name: reverseKeysParameter,
    Type: "SecureString",
    Value: `1:${Buffer.alloc(32, 9).toString("base64url")}`,
  }).pipe(Effect.as(ReverseKeys.fromParameter(reverseKeysParameter))),
).pipe(Layer.provide(aws));

/**
 * The image proxy Lambda behind its own function URL (PLAN.md §20.19), keys from Parameter Store
 * like the inbound Lambda's signer, which points at it. Its egress reaches only 127.0.0.1, where
 * a test runs the sender's image host; production's policy is tested in `apps/image-proxy`.
 */
const imageProxyParameter = "/alias/e2e/image-proxy-keys";
const imageProxy = Layer.unwrap(
  Effect.gen(function* () {
    yield* SSM.putParameter({
      Name: imageProxyParameter,
      Type: "SecureString",
      Value: `1:${Buffer.alloc(32, 11).toString("base64url")}`,
    });
    const keys = yield* Parameters.keyring(imageProxyParameter);
    const services = Layer.mergeAll(
      Layer.succeed(Proxy.ProxyKeys, keys),
      ImageProxyTesting.onlyLoopback,
      NodeCrypto.layer,
    );
    const { url } = yield* FunctionUrlServer.make({
      handler: (event) =>
        Effect.runPromise(
          FunctionUrl.decode(event).pipe(Effect.flatMap(Proxy.handle), Effect.provide(services)),
        ),
    });
    return Layer.succeed(ImageProxySigner.ImageProxySigner, { base: url, keys });
  }),
).pipe(Layer.provide(aws));

/** The real inbound pipeline on the same table, spool, SES and keys. */
const inbound = Pipeline.layer(
  Layer.mergeAll(
    database,
    inboxStore,
    tempDomains,
    webhookQueue,
    sending,
    Spool.layer(spoolBucket).pipe(Layer.provide(aws)),
    sharedDomains,
    reverseKeys,
    imageProxy,
  ),
);

type Verdicts =
  NonNullable<SesEmulator.SesEmulatorConfig["verdicts"]> extends (
    recipients: ReadonlyArray<string>,
  ) => infer V
    ? V
    : never;

const passing: Verdicts = { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" };

/** What SES will stamp on the next received message; a test sets it before sending. */
const verdicts = { next: passing };

/**
 * The shared domain's SES identity, which SES receives for and sends from, and the temp-mail
 * domain's, which it only receives for.
 */
const sharedIdentity = Layer.effectDiscard(
  Effect.forEach(["alias.test", "tmp.test"], Transport.ensureIdentity, {
    concurrency: 1,
    discard: true,
  }),
).pipe(Layer.provide(aws));

// Like SES, receives for the account's verified domain identities: the shared and temp-mail
// domains, and each
// custom domain once the API created its identity.
const ses = SesEmulator.layer({
  verifiedDomains: "identities",
  rules: [
    {
      name: "all-verified",
      enabled: true,
      recipients: [],
      s3: { bucket: spoolBucket, objectKeyPrefix: Inbound.spoolPrefix },
      lambda: {
        functionArn: "arn:aws:lambda:eu-west-1:000000000000:function:inbound",
        invocationType: "Event",
      },
      scanEnabled: true,
    },
  ],
  verdicts: () => verdicts.next,
}).pipe(Layer.provide([aws, spool, sharedIdentity]));

/** The feedback Lambda on the same table and SES. */
const feedback = Feedback.layer(Layer.mergeAll(database, sending, webhookQueue));

/** The webhook delivery Lambda behind the emulated SQS event source mapping of the queue. */
const delivery = Layer.effect(
  SqsEventSource.SqsEventSource,
  Effect.gen(function* () {
    const { queueUrl } = yield* TestQueue;
    const context = yield* Layer.build(
      Delivery.layer(
        Layer.mergeAll(
          database,
          webhookQueue,
          Delivery.production,
          NodeCrypto.layer,
          Egress.layer,
          webhookKeys,
        ).pipe(Layer.provideMerge(urlPolicy)),
      ),
    );
    return yield* SqsEventSource.make({
      queueUrl,
      handler: (event) =>
        SqsEvent.decode(event).pipe(Effect.flatMap(Delivery.handle), Effect.provide(context)),
    });
  }),
).pipe(Layer.provide(Layer.merge(webhookQueue, aws)));

/** Everything, with `api` (a layer that serves `apiHandler`) on the same table, queue and fakecloud. */
export const layer = <ROut, E, RIn>(api: Layer.Layer<ROut, E, RIn>) =>
  Layer.mergeAll(
    api.pipe(Layer.provide(Layer.mergeAll(database, webhookQueue, inboxStore, webhookKeys))),
    inbound,
    feedback,
    delivery,
    feedbackTopic,
    ses,
    aws,
  ).pipe(
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(Layer.merge(FakeCloud.layer(), DohServer.layer())),
  );

const decoder = new TextDecoder();

/** Mail SES sent to `address`, oldest first, as raw text. */
export const sentTo = (address: string) =>
  Effect.map(FakeCloud.sentEmails(), (emails) =>
    Arr.map(
      Arr.filter(emails, (email) => Arr.contains(email.to, address)),
      (email) => ({
        ...email,
        text: decoder.decode(Option.getOrElse(email.raw, () => new Uint8Array())),
      }),
    ),
  );

/** Sends one message over SMTP and returns the Lambda event SES emits for it, as JSON. */
export const smtp = (mail: {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly headers?: Record<string, string>;
  readonly verdicts?: Partial<Verdicts>;
}) =>
  Effect.gen(function* () {
    const emulator = yield* SesEmulator.SesEmulator;
    verdicts.next = { ...passing, ...mail.verdicts };
    yield* Effect.tryPromise(() =>
      createTransport({
        host: "127.0.0.1",
        port: emulator.smtpPort,
        secure: false,
        ignoreTLS: true,
      }).sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        headers: mail.headers ?? {},
      }),
    );
    verdicts.next = passing;
    // Lambda passes the event as JSON; the handler parses it as `src/handler.ts` does.
    const json: unknown = JSON.parse(JSON.stringify(yield* Queue.take(emulator.events)));
    return yield* SesEvent.decode(json);
  });

/** Sends a raw message over SMTP as-is (a mailbox's redirect rule) and returns its event. */
export const smtpRaw = (mail: {
  readonly from: string;
  readonly to: string;
  readonly raw: string;
}) =>
  Effect.gen(function* () {
    const emulator = yield* SesEmulator.SesEmulator;
    yield* Effect.tryPromise(() =>
      createTransport({
        host: "127.0.0.1",
        port: emulator.smtpPort,
        secure: false,
        ignoreTLS: true,
      }).sendMail({ envelope: { from: mail.from, to: [mail.to] }, raw: mail.raw }),
    );
    const json: unknown = JSON.parse(JSON.stringify(yield* Queue.take(emulator.events)));
    return yield* SesEvent.decode(json);
  });
