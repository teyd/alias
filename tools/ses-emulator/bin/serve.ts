/**
 * Standalone emulator for `pnpm dev`, spooling to the fakecloud started by `scripts/dev.ts`.
 * Tests start it in-process instead (see test/).
 */
import { AwsClient, Inbound, Transport } from "@alias/aws";
import { NodeCrypto, NodeRuntime } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import { SesEmulator } from "../src/index.ts";

const sharedDomains = (process.env.ALIAS_SHARED_DOMAINS ?? "alias.test").split(",");
const verifiedDomains = [...sharedDomains, "custom.test"];
const spoolBucket = "alias-spool";
const fakecloudUrl = `http://127.0.0.1:${process.env.ALIAS_FAKECLOUD_PORT ?? 4566}`;
const awsClient = AwsClient.emulator(fakecloudUrl);

const EmulatorLive = SesEmulator.layer({
  smtpPort: Number(process.env.ALIAS_SMTP_PORT ?? 2525),
  verifiedDomains,
  rules: [
    {
      name: "all-verified",
      enabled: true,
      recipients: [],
      s3: { bucket: spoolBucket, objectKeyPrefix: Inbound.spoolPrefix },
      lambda: {
        functionArn: "arn:aws:lambda:eu-west-1:000000000000:function:alias-inbound",
        invocationType: "Event",
      },
      scanEnabled: true,
    },
  ],
}).pipe(Layer.provide([NodeCrypto.layer, awsClient]));

// Until the inbound Lambda exists (roadmap phase 3), dev logs the events SES would invoke it with.
const logEvents = Effect.fn("ses-emulator.serve")(function* () {
  const emulator = yield* SesEmulator.SesEmulator;
  yield* Effect.logInfo(
    `ses-emulator listening on smtp://127.0.0.1:${emulator.smtpPort}, spooling to s3://${spoolBucket}/${Inbound.spoolPrefix}`,
  );
  yield* Queue.take(emulator.events).pipe(
    Effect.flatMap((event) =>
      Effect.forEach(
        event.Records,
        (record) =>
          Effect.logInfo(
            `received ${record.ses.mail.messageId} for ${record.ses.receipt.recipients.join(", ")}`,
          ),
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.forever,
  );
});

// fakecloud starts alongside; retry until it accepts the bucket and the sending identities.
const untilFakeCloudIsUp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
    Effect.provide(awsClient),
  );

const ensureSpool = untilFakeCloudIsUp(Inbound.ensureSpool(spoolBucket));

const ensureIdentities = untilFakeCloudIsUp(
  Effect.forEach(verifiedDomains, Transport.ensureIdentity, { concurrency: 1, discard: true }),
).pipe(Effect.andThen(Effect.logInfo(`read sent mail at ${fakecloudUrl}/_fakecloud/ses/emails`)));

NodeRuntime.runMain(
  ensureSpool.pipe(
    Effect.andThen(ensureIdentities),
    Effect.andThen(logEvents()),
    Effect.provide(EmulatorLive),
  ),
);
