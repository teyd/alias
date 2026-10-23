import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Authentication } from "./Auth.ts";

/** What a webhook endpoint can subscribe to; the `type` of each event it receives. */
export const WebhookEventType = Schema.Literals([
  "alias.created",
  "alias.deleted",
  "mail.forwarded",
  "mail.blocked",
  "recipient.bounced",
  "rule.matched",
]);
export type WebhookEventType = typeof WebhookEventType.Type;

const AliasRef = { aliasId: Schema.String, address: Schema.String };

/**
 * The body of each delivery, Standard Webhooks style: `type`, when the event happened, and
 * `data`. Metadata only: never message content, subjects or a sender's address. A sender is
 * named by its contact id, which the contacts API resolves for the alias owner.
 */
export const WebhookEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("alias.created"),
    timestamp: Schema.String,
    data: Schema.Struct({
      ...AliasRef,
      /** `api`: created by the owner; `on-the-fly`: by the first mail to it (§20.8). */
      origin: Schema.Literals(["api", "on-the-fly"]),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("alias.deleted"),
    timestamp: Schema.String,
    data: Schema.Struct(AliasRef),
  }),
  Schema.Struct({
    type: Schema.Literal("mail.forwarded"),
    timestamp: Schema.String,
    data: Schema.Struct({ ...AliasRef, contactId: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("mail.blocked"),
    timestamp: Schema.String,
    data: Schema.Struct({
      ...AliasRef,
      /** Why: `spam`, `virus`, `blocked-contact`, `loop`, `rate-limited`, `inactive-alias`, … */
      reason: Schema.String,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("rule.matched"),
    timestamp: Schema.String,
    /** One of the owner's rules with a `webhook` action matched mail to the alias (§20.32). */
    data: Schema.Struct({ ...AliasRef, ruleId: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("recipient.bounced"),
    timestamp: Schema.String,
    /** The owner's own forwarding address, which SES reported as permanently bouncing. */
    data: Schema.Struct({ address: Schema.String }),
  }),
]);
export type WebhookEvent = typeof WebhookEvent.Type;

const Webhook = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  eventTypes: Schema.Array(WebhookEventType),
  /** Paused by its owner, or after the endpoint answered `410 Gone`. */
  isEnabled: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
});
export type Webhook = typeof Webhook.Type;

/** The webhook with its signing secret (`whsec_…`), shown this once. */
const WithSecret = Schema.Struct({ ...Webhook.fields, secret: Schema.String });

const NewWebhook = Schema.Struct({
  url: Schema.String,
  eventTypes: Schema.NonEmptyArray(WebhookEventType),
});

const WebhookChanges = Schema.Struct({
  eventTypes: Schema.optionalKey(Schema.NonEmptyArray(WebhookEventType)),
  isEnabled: Schema.optionalKey(Schema.Boolean),
});

/** Not a URL webhooks may be sent to (`WebhookUrl.check` in `@alias/core`). */
export class InvalidWebhookUrl extends Schema.TaggedError<InvalidWebhookUrl>()(
  "InvalidWebhookUrl",
  {
    reason: Schema.Literals([
      "invalid-url",
      "not-https",
      "has-credentials",
      "not-public-host",
      "too-long",
    ]),
  },
  { httpApiStatus: 400 },
) {}

export class TooManyWebhooks extends Schema.TaggedError<TooManyWebhooks>()(
  "TooManyWebhooks",
  { limit: Schema.Number },
  { httpApiStatus: 409 },
) {}

export class WebhookNotFound extends Schema.TaggedError<WebhookNotFound>()(
  "WebhookNotFound",
  { webhookId: Schema.String },
  { httpApiStatus: 404 },
) {}

const webhookId = { webhookId: Schema.String };

/**
 * Webhook endpoints. Session-only: an endpoint is a standing data sink, so registering one takes
 * a passkey sign-in, not a token. Rotating the secret returns a new one; deliveries are signed
 * with both for 24 hours, so receivers can switch without dropping any.
 */
export const WebhooksGroup = HttpApiGroup.make("webhooks")
  .add(HttpApiEndpoint.get("list", "/webhooks", { success: Schema.Array(Webhook) }))
  .add(
    HttpApiEndpoint.post("create", "/webhooks", {
      payload: NewWebhook,
      success: WithSecret.pipe(HttpApiSchema.status(201)),
      error: [InvalidWebhookUrl, TooManyWebhooks],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/webhooks/:webhookId", {
      params: webhookId,
      payload: WebhookChanges,
      success: Webhook,
      error: WebhookNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("rotateSecret", "/webhooks/:webhookId/secret", {
      params: webhookId,
      success: WithSecret,
      error: WebhookNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/webhooks/:webhookId", {
      params: webhookId,
      error: WebhookNotFound,
    }),
  )
  .middleware(Authentication)
  .prefix("/v1");
