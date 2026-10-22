/**
 * Inbound mail for `pnpm dev`: the SES emulator (SMTP → receipt rules → S3 spool) on the fakecloud
 * that `scripts/dev.ts` starts, with every Lambda event it emits handed to the real inbound
 * pipeline, the way SES invokes the Lambda asynchronously. Forwarded mail and replies land in
 * fakecloud's sent mail.
 *
 * The reverse-token key is a fixed dev key unless `ALIAS_REVERSE_TOKEN_KEYS` is set. Never use it
 * anywhere real: anyone with this repo can mint reverse aliases for it.
 */
import { AwsClient, Inbound, SesEvent, Transport } from "@alias/aws";
import { SharedDomains } from "@alias/core";
import { Dynamo, Table } from "@alias/db";
import { SesEmulator } from "@alias/ses-emulator";
import { NodeCrypto, NodeRuntime } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Pipeline, ReverseKeys, Spool } from "../src/index.ts";

const DEV_REVERSE_TOKEN_KEYS = "1:ZGV2LW9ubHktcmV2ZXJzZS10b2tlbi1rZXktbm90LXNlY3JldA";

const sharedDomainsValue = process.env.ALIAS_SHARED_DOMAINS ?? "alias.test";
const spoolBucket = "alias-spool";
const fakecloudUrl = `http://127.0.0.1:${process.env.ALIAS_FAKECLOUD_PORT ?? 4566}`;
const awsClient = AwsClient.emulator(fakecloudUrl);
const sharedDomains = SharedDomains.layer(sharedDomainsValue);

const pipeline = Pipeline.layer(
  Layer.mergeAll(
    Dynamo.emulator(fakecloudUrl, "alias"),
    Transport.ses.pipe(Layer.provide(awsClient)),
    Spool.layer(spoolBucket).pipe(Layer.provide(awsClient)),
    sharedDomains,
    ReverseKeys.layer(
      Redacted.make(process.env.ALIAS_REVERSE_TOKEN_KEYS ?? DEV_REVERSE_TOKEN_KEYS),
    ),
  ),
);

/** The dev domains, verified as SES identities so forwarded mail and replies can be sent. */
const devDomains = SharedDomains.SharedDomains.use((domains) =>
  Effect.succeed([...domains, "custom.test"]),
);

const emulator = Layer.unwrap(
  Effect.map(devDomains, (verifiedDomains) =>
    SesEmulator.layer({
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
    }),
  ),
).pipe(Layer.provide([NodeCrypto.layer, awsClient, sharedDomains]));

// fakecloud starts alongside; retry until it accepts the bucket, the identities and the table.
const untilFakeCloudIsUp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }));

const prepare = Effect.fn("inbound.dev.prepare")(function* () {
  yield* untilFakeCloudIsUp(Inbound.ensureSpool(spoolBucket)).pipe(Effect.provide(awsClient));
  const domains = yield* devDomains;
  // fakecloud only accepts senders on an exactly verified domain, while AWS also accepts the
  // subdomains (PLAN.md §20.5). Mail to `<user>.alias.test` aliases is refused until the
  // subdomain is verified too.
  yield* untilFakeCloudIsUp(
    Effect.forEach(domains, Transport.ensureIdentity, { concurrency: 1, discard: true }),
  ).pipe(Effect.provide(awsClient));
  yield* untilFakeCloudIsUp(Table.ensure()).pipe(
    Effect.provide(Dynamo.emulator(fakecloudUrl, "alias")),
  );
});

/** The pipeline logs each outcome. Lambda would retry a failed event; dev logs it instead. */
const invoke = (event: SesEvent.SesEvent) =>
  Pipeline.handle(event).pipe(
    Effect.catch((error) => Effect.logError("inbound failed; Lambda would retry", error)),
  );

const serve = Effect.fn("inbound.dev")(function* () {
  yield* prepare();
  const ses = yield* SesEmulator.SesEmulator;
  yield* Effect.logInfo(
    `ses-emulator on smtp://127.0.0.1:${ses.smtpPort}, spooling to s3://${spoolBucket}/${Inbound.spoolPrefix}; sent mail at ${fakecloudUrl}/_fakecloud/ses/emails`,
  );
  yield* Queue.take(ses.events).pipe(Effect.flatMap(invoke), Effect.forever);
});

NodeRuntime.runMain(
  serve().pipe(Effect.provide(Layer.mergeAll(emulator, pipeline, sharedDomains))),
);
