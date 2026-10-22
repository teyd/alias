import { AwsClient, Transport } from "@alias/aws";
import request from "@alias/aws/fixtures/sesv2-send-email-request.json" with { type: "json" };
import * as Retry from "@distilled.cloud/aws/Retry";
import * as SESV2 from "@distilled.cloud/aws/sesv2";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FakeCloud } from "../src/index.ts";

const readRawMessage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFile(
    yield* path.fromFileUrl(
      new URL(import.meta.resolve("@alias/aws/fixtures/sesv2-raw-message.eml")),
    ),
  );
}).pipe(
  // NodeFileSystem returns a Buffer, which never deep-equals a plain Uint8Array.
  Effect.map((bytes) => new Uint8Array(bytes)),
  Effect.provide(NodeServices.layer),
);
const envelope: Transport.Envelope = {
  from: request.FromEmailAddress,
  to: Schema.decodeUnknownSync(Schema.NonEmptyArray(Schema.String))(
    request.Destination.ToAddresses,
  ),
};

const client = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), ({ url }) => AwsClient.emulator(url)),
);
const live = Transport.ses.pipe(Layer.provideMerge(client), Layer.provideMerge(FakeCloud.layer()));

const send = (raw: Uint8Array, to: Transport.Envelope) =>
  Effect.flatMap(Transport.Transport, (transport) => transport.send(raw, to));

/** Changes account-wide SES state for one test and puts it back afterwards. */
const withAccount = <A, E, R, E2, R2>(
  set: Effect.Effect<unknown, E2, R2>,
  reset: Effect.Effect<unknown, E2, R2>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    set,
    () => effect,
    () => Effect.orDie(reset),
  );

const sandbox = (isOn: boolean) =>
  SESV2.putAccountDetails({
    MailType: "TRANSACTIONAL",
    WebsiteURL: "https://example.com",
    UseCaseDescription: "Transport tests",
    ProductionAccessEnabled: !isOn,
  });

describe("SES sending on fakecloud (SESv2 SendEmail, Content.Raw)", () => {
  it.layer(live, { timeout: 30_000 })((it) => {
    it.effect("accepts the documented request and stores the raw message byte for byte", () =>
      Effect.gen(function* () {
        const rawMessage = yield* readRawMessage;
        yield* Transport.ensureIdentity("example.com");
        const messageId = yield* send(rawMessage, envelope);
        const sent = Arr.findFirst(
          yield* FakeCloud.sentEmails(),
          (email) => email.messageId === messageId,
        );
        expect(Option.map(sent, (email) => email.from)).toEqual(
          Option.some(request.FromEmailAddress),
        );
        expect(Option.map(sent, (email) => email.to)).toEqual(
          Option.some(request.Destination.ToAddresses),
        );
        expect(Option.flatMap(sent, (email) => email.raw)).toEqual(Option.some(rawMessage));
      }),
    );

    it.effect("ensureIdentity is a no-op when the identity exists", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("twice.test");
        yield* Transport.ensureIdentity("twice.test");
        const identity = yield* SESV2.getEmailIdentity({ EmailIdentity: "twice.test" });
        expect(identity.VerifiedForSendingStatus).toBe(true);
      }),
    );

    it.effect("rejects a message from an unverified sender", () =>
      Effect.gen(function* () {
        const rawMessage = yield* readRawMessage;
        const error = yield* Effect.flip(
          send(rawMessage, { from: "someone@unverified.test", to: ["recipient@example.com"] }),
        );
        expect(error._tag).toBe("TransportRejected");
        expect(error.code).toBe("MessageRejected");
      }),
    );

    it.effect("rejects an unverified recipient while the account is in the sandbox", () =>
      Effect.gen(function* () {
        const rawMessage = yield* readRawMessage;
        yield* Transport.ensureIdentity("example.com");
        const error = yield* withAccount(
          sandbox(true),
          sandbox(false),
          Effect.flip(send(rawMessage, { ...envelope, to: ["stranger@elsewhere.test"] })),
        );
        expect(error._tag).toBe("TransportRejected");
        expect(error.code).toBe("MessageRejected");
        yield* send(rawMessage, { ...envelope, to: ["stranger@elsewhere.test"] });
      }),
    );

    // A known divergence (PLAN.md §20.11): AWS documents that SES accepts mail to a suppressed
    // address and doesn't send it (a bounce event follows); fakecloud refuses it. The pipeline
    // relies on neither: it stops forwarding to a hard-bounced recipient itself.
    it.effect("fakecloud refuses a suppressed recipient (AWS accepts and drops it)", () =>
      Effect.gen(function* () {
        const rawMessage = yield* readRawMessage;
        yield* Transport.ensureIdentity("example.com");
        const address = "bounced@elsewhere.test";
        const error = yield* withAccount(
          SESV2.putSuppressedDestination({ EmailAddress: address, Reason: "BOUNCE" }),
          SESV2.deleteSuppressedDestination({ EmailAddress: address }),
          Effect.flip(send(rawMessage, { ...envelope, to: [address] })),
        );
        expect(error._tag).toBe("TransportRejected");
        expect(error.code).toBe("MessageRejected");
        yield* send(rawMessage, { ...envelope, to: [address] });
      }),
    );

    it.effect("puts addresses on the suppression list and takes them off, idempotently", () =>
      Effect.gen(function* () {
        const transport = yield* Transport.Transport;
        const address = "gone@elsewhere.test";
        yield* transport.suppress(address);
        yield* transport.suppress(address);
        const listed = yield* SESV2.getSuppressedDestination({ EmailAddress: address });
        expect(listed.SuppressedDestination).toMatchObject({
          EmailAddress: address,
          Reason: "BOUNCE",
        });
        yield* transport.unsuppress(address);
        yield* transport.unsuppress(address);
        const gone = yield* Effect.flip(SESV2.getSuppressedDestination({ EmailAddress: address }));
        expect(gone._tag).toBe("NotFoundException");
      }),
    );

    it.effect("sends through a configuration set with message tags", () =>
      Effect.gen(function* () {
        const rawMessage = yield* readRawMessage;
        yield* Transport.ensureIdentity("example.com");
        yield* SESV2.createConfigurationSet({ ConfigurationSetName: "events" });
        const tagged = Transport.layer({ configurationSet: Option.some("events") });
        const messageId = yield* Effect.flatMap(Transport.Transport, (transport) =>
          transport.send(rawMessage, {
            ...envelope,
            tags: [{ name: "alias-kind", value: "forward" }],
          }),
        ).pipe(Effect.provide(tagged.pipe(Layer.provide(client))));
        expect(messageId).not.toBe("");
        // That the event destination sees the tags is checked end to end in apps/inbound
        // (feedback.test.ts), where the events arrive.
      }),
    );

    it.effect("keeps the message for a retry while sending is paused", () =>
      Effect.gen(function* () {
        const rawMessage = yield* readRawMessage;
        yield* Transport.ensureIdentity("example.com");
        const error = yield* withAccount(
          SESV2.putAccountSendingAttributes({ SendingEnabled: false }),
          SESV2.putAccountSendingAttributes({ SendingEnabled: true }),
          Effect.flip(send(rawMessage, envelope)),
        );
        expect(error._tag).toBe("TransportRetryable");
        expect(error.code).toBe("SendingPausedException");
        yield* send(rawMessage, envelope);
      }),
    );
  });

  it.layer(Transport.ses.pipe(Layer.provide(AwsClient.emulator("http://127.0.0.1:1"))))((it) => {
    it.effect("keeps the message for a retry when SES is unreachable", () =>
      Effect.gen(function* () {
        const rawMessage = yield* readRawMessage;
        const error = yield* Effect.flip(send(rawMessage, envelope).pipe(Retry.none));
        expect(error._tag).toBe("TransportRetryable");
      }),
    );
  });
});
