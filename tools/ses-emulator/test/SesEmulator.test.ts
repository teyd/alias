import { AwsClient, Inbound, SesEvent } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { createTransport } from "nodemailer";
import { SesEmulator } from "../src/index.ts";

const bucket = "spool";

const config = {
  verifiedDomains: ["alias.test", "custom.test"],
  rules: [
    {
      name: "all-verified",
      enabled: true,
      recipients: [],
      s3: { bucket, objectKeyPrefix: Inbound.spoolPrefix },
      lambda: {
        functionArn: "arn:aws:lambda:eu-west-1:000000000000:function:inbound",
        invocationType: "Event",
      },
      scanEnabled: true,
    },
  ],
} satisfies SesEmulator.SesEmulatorConfig;

// S3 is fakecloud; the bucket exists before SMTP opens, as it must on AWS.
const s3 = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), (fakecloud) => AwsClient.emulator(fakecloud.url)),
).pipe(Layer.provide(FakeCloud.layer()));
const spool = Layer.effectDiscard(Inbound.ensureSpool(bucket)).pipe(Layer.provideMerge(s3));
const emulator = SesEmulator.layer(config).pipe(
  Layer.provideMerge(spool),
  Layer.provide(NodeCrypto.layer),
);

const send = (port: number, to: string) =>
  Effect.tryPromise(() =>
    createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true }).sendMail({
      from: '"Doe, Jane" <sender@external.test>',
      to,
      subject: "Your code is 493021",
      text: "Grüße: Use 493021 to sign in.",
    }),
  );

describe("SesEmulator (in-process SMTP on port 0, S3 on fakecloud)", () => {
  it.layer(emulator, { timeout: 30_000 })((it) => {
    it.effect("spools accepted mail to S3 and emits the SES Lambda event", () =>
      Effect.gen(function* () {
        const ses = yield* SesEmulator.SesEmulator;
        expect(ses.smtpPort).toBeGreaterThan(0);

        yield* send(ses.smtpPort, "shop@user1.alias.test");
        const event = yield* Queue.take(ses.events);

        // Contract: the same schema decodes the payload documented by AWS (see @alias/aws).
        expect(Schema.is(SesEvent.SesEvent)(event)).toBe(true);
        const record = event.Records[0];
        expect(record?.ses.receipt.recipients).toEqual(["shop@user1.alias.test"]);
        expect(record?.ses.receipt.spamVerdict.status).toBe("PASS");
        expect(record?.ses.receipt.action.type).toBe("Lambda");
        expect(record?.ses.mail.commonHeaders.from).toEqual(['"Doe, Jane" <sender@external.test>']);
        expect(record?.ses.mail.commonHeaders.subject).toBe("Your code is 493021");

        const raw = new TextDecoder().decode(
          yield* Inbound.readMessage(bucket, record?.ses.mail.messageId ?? ""),
        );
        expect(raw).toMatch(/^Return-Path: <sender@external\.test>\r\n/);
        expect(raw).toContain("X-SES-Spam-Verdict: PASS");
        expect(raw).toContain("Subject: Your code is 493021");
      }),
    );

    it.effect("rejects recipients outside verified domains at RCPT time", () =>
      Effect.gen(function* () {
        const ses = yield* SesEmulator.SesEmulator;
        const exit = yield* Effect.exit(send(ses.smtpPort, "x@not-ours.test"));
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );

    it.effect("creating the spool bucket again is a no-op (dev restarts)", () =>
      Inbound.ensureSpool(bucket),
    );
  });
});
