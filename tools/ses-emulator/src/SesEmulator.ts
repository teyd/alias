import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { SMTPServer } from "smtp-server";
import { type AwsClient, Inbound, SesEvent } from "@alias/aws";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Clock from "effect/Clock";
import { commonHeaders, parseHeaders } from "./Headers.ts";
import { ruleMatches, type ReceiptRule } from "./ReceiptRules.ts";

class RecipientRejected extends Schema.TaggedError<RecipientRejected>()("RecipientRejected", {
  recipient: Schema.String,
  responseCode: Schema.Number,
}) {}

class SmtpFailure extends Schema.TaggedError<SmtpFailure>()("SmtpFailure", {
  reason: Schema.String,
}) {}

interface Verdicts {
  readonly spam: SesEvent.VerdictStatus;
  readonly virus: SesEvent.VerdictStatus;
  readonly spf: SesEvent.VerdictStatus;
  readonly dkim: SesEvent.VerdictStatus;
  readonly dmarc: SesEvent.VerdictStatus;
}

const passingVerdicts: Verdicts = {
  spam: "PASS",
  virus: "PASS",
  spf: "PASS",
  dkim: "PASS",
  dmarc: "PASS",
};

export interface SesEmulatorConfig {
  /** Port for the inbound SMTP listener. `0` picks a free port (the default, and what tests use). */
  readonly smtpPort?: number;
  readonly host?: string;
  readonly verifiedDomains: ReadonlyArray<string>;
  readonly rules: ReadonlyArray<ReceiptRule>;
  /** Verdicts stamped on the next messages; tests override this to simulate spam or DMARC failures. */
  readonly verdicts?: (recipients: ReadonlyArray<string>) => Verdicts;
}

export interface RunningEmulator {
  readonly smtpPort: number;
  /** One SES Lambda event per matching rule that has a Lambda action, as SES would invoke it. */
  readonly events: Queue.Dequeue<SesEvent.SesEvent>;
}

export class SesEmulator extends Context.Service<SesEmulator, RunningEmulator>()(
  "@alias/ses-emulator/SesEmulator",
) {}

const decodeListenAddress = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }));

const readStream = (stream: NodeJS.ReadableStream) =>
  Effect.tryPromise({
    try: () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const chunks: Array<Buffer> = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
        stream.on("error", reject);
      }),
    catch: (cause) => new SmtpFailure({ reason: String(cause) }),
  });

/** Headers SES prepends to every received message before storing it. */
const sesHeaders = (input: {
  readonly source: string;
  readonly messageId: string;
  readonly recipient: string;
  readonly timestamp: string;
  readonly verdicts: Verdicts;
  readonly scanEnabled: boolean;
}): string => {
  const lower = (status: SesEvent.VerdictStatus) => status.toLowerCase();
  const scan = input.scanEnabled
    ? [`X-SES-Spam-Verdict: ${input.verdicts.spam}`, `X-SES-Virus-Verdict: ${input.verdicts.virus}`]
    : [];
  return [
    `Return-Path: <${input.source}>`,
    `Received: from localhost by inbound-smtp.eu-west-1.amazonaws.com with SMTP id ${input.messageId} for ${input.recipient}; ${input.timestamp}`,
    ...scan,
    `Authentication-Results: amazonses.com; spf=${lower(input.verdicts.spf)}; dkim=${lower(input.verdicts.dkim)}; dmarc=${lower(input.verdicts.dmarc)}`,
    "",
  ].join("\r\n");
};

const make = Effect.fn("SesEmulator.make")(function* (config: SesEmulatorConfig) {
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<never>();
  const events = yield* Queue.unbounded<SesEvent.SesEvent>();
  // The S3 action writes through the real S3 API, to fakecloud in tests and dev.
  const client = yield* Effect.context<AwsClient.AwsClient>();
  const verdictsFor = config.verdicts ?? (() => passingVerdicts);

  const firstMatchingRule = (recipient: string) =>
    Arr.findFirst(config.rules, (rule) => ruleMatches(rule, recipient, config.verifiedDomains));

  const deliver = Effect.fn("SesEmulator.deliver")(function* (
    raw: Uint8Array,
    recipients: ReadonlyArray<string>,
    source: string,
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const verdicts = verdictsFor(recipients);
    const matched = Arr.flatMap(recipients, (recipient) =>
      Arr.fromOption(Option.map(firstMatchingRule(recipient), (rule) => ({ rule, recipient }))),
    );
    const byRule = R.values(Arr.groupBy(matched, (match) => match.rule.name));

    yield* Effect.forEach(
      byRule,
      Effect.fnUntraced(function* (group) {
        const rule = group[0].rule;
        const ruleRecipients = Arr.map(group, (match) => match.recipient);
        const messageId = yield* crypto.randomUUIDv4({ format: "hex" });
        const prepended = sesHeaders({
          source,
          messageId,
          recipient: group[0].recipient,
          timestamp,
          verdicts,
          scanEnabled: rule.scanEnabled,
        });
        // Bytes, not text: the message may carry 8-bit content that must reach S3 unchanged.
        const stored = new Uint8Array(Buffer.concat([new TextEncoder().encode(prepended), raw]));
        yield* S3.putObject({
          Bucket: rule.s3.bucket,
          Key: Inbound.objectKey(rule.s3.objectKeyPrefix, messageId),
          Body: stored,
        }).pipe(
          Effect.mapError(
            (error) => new SmtpFailure({ reason: `S3 action failed: ${String(error)}` }),
          ),
          Effect.provide(client),
        );

        const scanned = (status: SesEvent.VerdictStatus) => ({
          status: rule.scanEnabled ? status : ("DISABLED" as const),
        });
        const headers = parseHeaders(new TextDecoder().decode(stored));
        const processingTimeMillis = (yield* Clock.currentTimeMillis) - startedAt;

        yield* Option.match(Option.fromUndefinedOr(rule.lambda), {
          onNone: () => Effect.void,
          onSome: (lambda) =>
            Queue.offer(events, {
              Records: [
                {
                  eventSource: "aws:ses",
                  eventVersion: "1.0",
                  ses: {
                    mail: {
                      timestamp,
                      source,
                      messageId,
                      destination: recipients,
                      headers,
                      commonHeaders: commonHeaders(headers, source),
                    },
                    receipt: {
                      timestamp,
                      processingTimeMillis,
                      recipients: ruleRecipients,
                      spamVerdict: scanned(verdicts.spam),
                      virusVerdict: scanned(verdicts.virus),
                      spfVerdict: { status: verdicts.spf },
                      dkimVerdict: { status: verdicts.dkim },
                      dmarcVerdict: { status: verdicts.dmarc },
                      action: {
                        type: "Lambda",
                        functionArn: lambda.functionArn,
                        invocationType: lambda.invocationType,
                      },
                    },
                  },
                },
              ],
            }),
        });
      }),
      { concurrency: 1, discard: true },
    );
  });

  // smtp-server is callback-based; each SMTP session runs its Effect with the emulator's context.
  const run = Effect.runPromiseWith(context);

  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    logger: false,
    onRcptTo(address, _session, callback) {
      Option.match(firstMatchingRule(address.address), {
        onNone: () =>
          callback(new RecipientRejected({ recipient: address.address, responseCode: 550 })),
        onSome: () => callback(),
      });
    },
    onData(stream, session, callback) {
      const recipients = Arr.map(session.envelope.rcptTo, (rcpt) => rcpt.address);
      const source = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
      run(readStream(stream).pipe(Effect.flatMap((raw) => deliver(raw, recipients, source)))).then(
        () => callback(),
        (error: Error) => callback(error),
      );
    },
  });

  const smtpPort = yield* Effect.acquireRelease(
    Effect.callback<number, SmtpFailure>((resume) => {
      server.once("error", (error) =>
        resume(Effect.fail(new SmtpFailure({ reason: error.message }))),
      );
      server.listen(config.smtpPort ?? 0, config.host ?? "127.0.0.1", () => {
        resume(
          decodeListenAddress(server.server.address()).pipe(
            Effect.map((address) => address.port),
            Effect.mapError(() => new SmtpFailure({ reason: "SMTP server has no TCP address" })),
          ),
        );
      });
    }),
    () => Effect.callback<void>((resume) => server.close(() => resume(Effect.void))),
  );

  return SesEmulator.of({
    smtpPort,
    events,
  });
});

export const layer = (config: SesEmulatorConfig) => Layer.effect(SesEmulator, make(config));
