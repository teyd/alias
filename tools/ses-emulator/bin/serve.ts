/**
 * Standalone emulator for `pnpm dev`, spooling to the fakecloud started by `scripts/dev.ts`.
 * Tests start it in-process instead (see test/).
 */
import { AwsClient, Inbound } from "@alias/aws";
import { NodeCrypto, NodeRuntime } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import { SesEmulator } from "../src/index.ts";

const sharedDomains = (process.env.ALIAS_SHARED_DOMAINS ?? "alias.test").split(",");
const spoolBucket = "alias-spool";
const awsClient = AwsClient.emulator(
  `http://127.0.0.1:${process.env.ALIAS_FAKECLOUD_PORT ?? 4566}`,
);

const EmulatorLive = SesEmulator.layer({
  smtpPort: Number(process.env.ALIAS_SMTP_PORT ?? 2525),
  verifiedDomains: [...sharedDomains, "custom.test"],
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

// fakecloud starts alongside; retry until it accepts the bucket.
const ensureSpool = Inbound.ensureSpool(spoolBucket).pipe(
  Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
  Effect.provide(awsClient),
);

NodeRuntime.runMain(ensureSpool.pipe(Effect.andThen(logEvents()), Effect.provide(EmulatorLive)));
