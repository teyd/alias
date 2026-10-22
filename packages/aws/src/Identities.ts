import * as SESV2 from "@distilled.cloud/aws/sesv2";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as AwsClient from "./Client.ts";

/**
 * Custom domains as SES identities (SESv2, Easy DKIM; PLAN.md §20.18). Creating a domain identity
 * returns three DKIM tokens; SES looks for their CNAMEs for up to 72 hours and verifies the domain
 * once it finds them. Production code reads only what it needs from the responses, through the
 * schemas below, which also decode the documented responses in `fixtures/`.
 * https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_CreateEmailIdentity.html
 * https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetEmailIdentity.html
 */

/** `DkimAttributes.Status`. */
export const DkimStatus = Schema.Literals([
  "PENDING",
  "SUCCESS",
  "FAILED",
  "TEMPORARY_FAILURE",
  "NOT_STARTED",
]);
export type DkimStatus = typeof DkimStatus.Type;

/** The fields of `CreateEmailIdentity` and `GetEmailIdentity` responses the service relies on. */
export const IdentityResponse = Schema.Struct({
  IdentityType: Schema.Literal("DOMAIN"),
  // SES's own field name.
  // oxlint-disable-next-line effect/require-is-prefix-for-boolean-schema-field
  VerifiedForSendingStatus: Schema.Boolean,
  DkimAttributes: Schema.Struct({
    Status: DkimStatus,
    Tokens: Schema.Array(Schema.NonEmptyString),
    SigningHostedZone: Schema.optionalKey(Schema.NonEmptyString),
  }),
});
export type IdentityResponse = typeof IdentityResponse.Type;

/** A domain identity as the service sees it. */
export interface DomainIdentity {
  readonly isVerifiedForSending: boolean;
  readonly dkimStatus: DkimStatus;
  readonly dkimTokens: ReadonlyArray<string>;
  /** Where the DKIM CNAMEs point; None when SES names no zone. */
  readonly dkimZone: Option.Option<string>;
}

const toIdentity = (response: IdentityResponse): DomainIdentity => ({
  isVerifiedForSending: response.VerifiedForSendingStatus,
  dkimStatus: response.DkimAttributes.Status,
  dkimTokens: response.DkimAttributes.Tokens,
  dkimZone: Option.fromUndefinedOr(response.DkimAttributes.SigningHostedZone),
});

/** SES already has an identity for this domain (in this account). */
export class IdentityExists extends Schema.TaggedError<IdentityExists>()("IdentityExists", {
  domain: Schema.String,
}) {}

/** SES couldn't be asked now, or answered with something unexpected. */
export class IdentityUnavailable extends Schema.TaggedError<IdentityUnavailable>()(
  "IdentityUnavailable",
  { operation: Schema.String, reason: Schema.String },
) {}

const unavailable = (operation: string) => (cause: unknown) =>
  new IdentityUnavailable({ operation, reason: String(cause) });

/** What the SDK returns, read strictly: it types every field optional. */
const decode =
  (operation: string) =>
  (response: SESV2.CreateEmailIdentityResponse | SESV2.GetEmailIdentityResponse) =>
    Schema.decodeUnknownEffect(IdentityResponse)(response).pipe(
      Effect.map(toIdentity),
      Effect.mapError(unavailable(operation)),
    );

export class Identities extends Context.Service<
  Identities,
  {
    /**
     * Starts verifying `domain` with Easy DKIM, sets its custom MAIL FROM domain
     * (`mailFromDomain`, falling back to SES's own while its MX is missing) and turns email
     * feedback forwarding off (bounces reach the feedback Lambda as events, PLAN.md §20.11).
     */
    readonly create: (
      domain: string,
      mailFromDomain: string,
    ) => Effect.Effect<DomainIdentity, IdentityExists | IdentityUnavailable>;
    /** None when SES has no identity for the domain. */
    readonly get: (
      domain: string,
    ) => Effect.Effect<Option.Option<DomainIdentity>, IdentityUnavailable>;
    /** Idempotent: a missing identity is fine. */
    readonly delete: (domain: string) => Effect.Effect<void, IdentityUnavailable>;
  }
>()("@alias/aws/Identities") {}

const make = Effect.fn("Identities.make")(function* () {
  const client = yield* Effect.context<AwsClient.AwsClient>();

  const configure = (domain: string, mailFromDomain: string) =>
    Effect.all(
      [
        SESV2.putEmailIdentityMailFromAttributes({
          EmailIdentity: domain,
          MailFromDomain: mailFromDomain,
          BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
        }).pipe(Effect.mapError(unavailable("PutEmailIdentityMailFromAttributes"))),
        SESV2.putEmailIdentityFeedbackAttributes({
          EmailIdentity: domain,
          EmailForwardingEnabled: false,
        }).pipe(Effect.mapError(unavailable("PutEmailIdentityFeedbackAttributes"))),
      ],
      { concurrency: 1, discard: true },
    );

  return Identities.of({
    create: (domain, mailFromDomain) =>
      SESV2.createEmailIdentity({ EmailIdentity: domain }).pipe(
        Effect.mapError((error) =>
          P.isTagged(error, "AlreadyExistsException")
            ? new IdentityExists({ domain })
            : unavailable("CreateEmailIdentity")(error),
        ),
        Effect.flatMap(decode("CreateEmailIdentity")),
        Effect.tap(() => configure(domain, mailFromDomain)),
        Effect.provide(client),
      ),
    get: (domain) =>
      SESV2.getEmailIdentity({ EmailIdentity: domain }).pipe(
        Effect.map((response) => Option.some(response)),
        Effect.catchTag("NotFoundException", () =>
          Effect.succeed(Option.none<SESV2.GetEmailIdentityResponse>()),
        ),
        Effect.mapError(unavailable("GetEmailIdentity")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (response) => Effect.asSome(decode("GetEmailIdentity")(response)),
          }),
        ),
        Effect.provide(client),
      ),
    delete: (domain) =>
      SESV2.deleteEmailIdentity({ EmailIdentity: domain }).pipe(
        Effect.asVoid,
        Effect.catchTag("NotFoundException", () => Effect.void),
        Effect.mapError(unavailable("DeleteEmailIdentity")),
        Effect.provide(client),
      ),
  });
});

/** SESv2 identities on whatever `AwsClient` points at. */
export const layer: Layer.Layer<Identities, never, AwsClient.AwsClient> = Layer.effect(
  Identities,
  make(),
);

/** From the Lambda environment: `AWS_ENDPOINT_URL_SESV2` only in emulated runs. */
export const config = Config.option(Config.String("AWS_ENDPOINT_URL_SESV2")).pipe(
  Config.map((endpoint) =>
    layer.pipe(Layer.provide(AwsClient.layer({ region: AwsClient.region, endpoint }))),
  ),
);
