import * as SESV2 from "@distilled.cloud/aws/sesv2";
import type * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { AwsClient } from "./Client.ts";

/** The ID SES assigns to an accepted message. */
export const MessageId = Schema.NonEmptyString.pipe(Schema.brand("MessageId"));
export type MessageId = typeof MessageId.Type;

/** Who the message is sent as and to. The raw message's own headers are not consulted. */
export interface Envelope {
  readonly from: string;
  readonly to: Arr.NonEmptyReadonlyArray<string>;
}

/** SES refused this message itself. Sending it again fails the same way, so drop it. */
export class TransportRejected extends Schema.TaggedError<TransportRejected>()(
  "TransportRejected",
  { code: Schema.String, message: Schema.String },
) {}

/** The message may be fine but couldn't be sent now (account, configuration, throughput, network). */
export class TransportRetryable extends Schema.TaggedError<TransportRetryable>()(
  "TransportRetryable",
  { code: Schema.String, message: Schema.String },
) {}

/**
 * Only errors about the message's own content drop it. Account and configuration problems
 * (sending paused, account suspended, MAIL FROM unverified) keep it for a retry once fixed.
 * https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html#API_SendEmail_Errors
 */
const rejectedCodes = HashSet.make<ReadonlyArray<SESV2.SendEmailError["_tag"]>>(
  "MessageRejected",
  "BadRequestException",
);

const classify = (error: SESV2.SendEmailError) => {
  const fields = { code: error._tag, message: String(error.message ?? "") };
  return HashSet.has(rejectedCodes, error._tag)
    ? new TransportRejected(fields)
    : new TransportRetryable(fields);
};

/** The `SendEmail` response as the service relies on it. */
export const SendEmailResult = Schema.Struct({ MessageId });
export type SendEmailResult = typeof SendEmailResult.Type;

const decodeResult = (response: SESV2.SendEmailResponse) =>
  Schema.decodeUnknownEffect(SendEmailResult)(response).pipe(
    Effect.map((result) => result.MessageId),
    Effect.mapError(
      (error) => new TransportRetryable({ code: "InvalidResponse", message: error.message }),
    ),
  );

export class Transport extends Context.Service<
  Transport,
  {
    /** Sends `raw` (an RFC 5322 message) unchanged to the envelope recipients. */
    readonly send: (
      raw: Uint8Array,
      envelope: Envelope,
    ) => Effect.Effect<MessageId, TransportRejected | TransportRetryable>;
  }
>()("@alias/aws/Transport") {}

const makeSes = Effect.fn("Transport.makeSes")(function* () {
  const client = yield* Effect.context<AwsClient>();
  return Transport.of({
    send: (raw, envelope) =>
      SESV2.sendEmail({
        FromEmailAddress: envelope.from,
        Destination: { ToAddresses: [...envelope.to] },
        Content: { Raw: { Data: raw } },
      }).pipe(Effect.mapError(classify), Effect.flatMap(decodeResult), Effect.provide(client)),
  });
});

/** SESv2 `SendEmail` with `Content.Raw`, on whatever `AwsClient` points at. */
export const ses: Layer.Layer<Transport, never, AwsClient> = Layer.effect(Transport, makeSes());

class IdentityError extends Schema.TaggedError<IdentityError>()("IdentityError", {
  identity: Schema.String,
  reason: Schema.String,
}) {}

/** Creates a sending identity if it doesn't exist. Emulators and dev only; Alchemy deploys real stages. */
export const ensureIdentity = Effect.fn("Transport.ensureIdentity")(function* (identity: string) {
  yield* SESV2.createEmailIdentity({ EmailIdentity: identity }).pipe(
    Effect.asVoid,
    Effect.catchTag("AlreadyExistsException", () => Effect.void),
    Effect.mapError((cause) => new IdentityError({ identity, reason: String(cause) })),
  );
});
