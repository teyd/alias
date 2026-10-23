import * as SESV2 from "@distilled.cloud/aws/sesv2";
import type * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AwsClient from "./Client.ts";

/** The ID SES assigns to an accepted message. */
export const MessageId = Schema.NonEmptyString.pipe(Schema.brand("MessageId"));
export type MessageId = typeof MessageId.Type;

/** Who the message is sent as and to. The raw message's own headers are not consulted. */
export interface Envelope {
  readonly from: string;
  readonly to: Arr.NonEmptyReadonlyArray<string>;
  /**
   * SES message tags (`EmailTags`), echoed in the bounce and complaint events of the
   * configuration set (`SendingEvent.tags`).
   */
  readonly tags?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/** The suppression list couldn't be changed now. */
export class SuppressionError extends Schema.TaggedError<SuppressionError>()("SuppressionError", {
  reason: Schema.String,
}) {}

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
    /**
     * Puts an address on the account-level suppression list (SESv2 `PutSuppressedDestination`),
     * after it bounced for good. SES then stops delivering to it. Idempotent.
     */
    readonly suppress: (address: string) => Effect.Effect<void, SuppressionError>;
    /** Takes an address off the suppression list, e.g. when its owner adds it again. */
    readonly unsuppress: (address: string) => Effect.Effect<void, SuppressionError>;
    /**
     * Whether the address is on the account-level suppression list (SESv2
     * `GetSuppressedDestination`; `NotFoundException` means it isn't). Mail the owner writes
     * (replies, compose, drafts) is refused for such an address instead of being sent for SES to
     * drop (PLAN.md §20.33).
     */
    readonly isSuppressed: (address: string) => Effect.Effect<boolean, SuppressionError>;
  }
>()("@alias/aws/Transport") {}

const suppressionError = (cause: unknown) => new SuppressionError({ reason: String(cause) });

const makeSes = Effect.fn("Transport.makeSes")(function* (configurationSet: Option.Option<string>) {
  const client = yield* Effect.context<AwsClient.AwsClient>();
  return Transport.of({
    send: (raw, envelope) =>
      SESV2.sendEmail({
        FromEmailAddress: envelope.from,
        Destination: { ToAddresses: [...envelope.to] },
        Content: { Raw: { Data: raw } },
        ...Option.match(configurationSet, {
          onNone: () => ({}),
          onSome: (name) => ({ ConfigurationSetName: name }),
        }),
        ...Option.match(Option.fromUndefinedOr(envelope.tags), {
          onNone: () => ({}),
          onSome: (tags) => ({
            EmailTags: tags.map((tag) => ({ Name: tag.name, Value: tag.value })),
          }),
        }),
      }).pipe(Effect.mapError(classify), Effect.flatMap(decodeResult), Effect.provide(client)),
    suppress: (address) =>
      SESV2.putSuppressedDestination({ EmailAddress: address, Reason: "BOUNCE" }).pipe(
        Effect.asVoid,
        Effect.mapError(suppressionError),
        Effect.provide(client),
      ),
    unsuppress: (address) =>
      SESV2.deleteSuppressedDestination({ EmailAddress: address }).pipe(
        Effect.asVoid,
        Effect.catchTag("NotFoundException", () => Effect.void),
        Effect.mapError(suppressionError),
        Effect.provide(client),
      ),
    isSuppressed: (address) =>
      SESV2.getSuppressedDestination({ EmailAddress: address }).pipe(
        Effect.as(true),
        Effect.catchTag("NotFoundException", () => Effect.succeed(false)),
        Effect.mapError(suppressionError),
        Effect.provide(client),
      ),
  });
});

/**
 * SESv2 on whatever `AwsClient` points at. Sends name `configurationSet` when given, whose event
 * destination reports bounces and complaints (PLAN.md §20.11).
 */
export const layer = (options: {
  readonly configurationSet: Option.Option<string>;
}): Layer.Layer<Transport, never, AwsClient.AwsClient> =>
  Layer.effect(Transport, makeSes(options.configurationSet));

/** SESv2 without a configuration set: no events. */
export const ses = layer({ configurationSet: Option.none() });

/**
 * SES from the Lambda environment: `ALIAS_SES_CONFIGURATION_SET`, and `AWS_ENDPOINT_URL_SESV2`
 * (the AWS-standard endpoint override) only in emulated runs.
 */
export const config = Config.all({
  endpoint: Config.option(Config.String("AWS_ENDPOINT_URL_SESV2")),
  configurationSet: Config.option(Config.String("ALIAS_SES_CONFIGURATION_SET")),
}).pipe(
  Config.map(({ endpoint, configurationSet }) =>
    layer({ configurationSet }).pipe(
      Layer.provide(AwsClient.layer({ region: AwsClient.region, endpoint })),
    ),
  ),
);

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
