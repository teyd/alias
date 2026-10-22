import {
  Api,
  CurrentUser,
  InvalidWebhookUrl,
  TooManyWebhooks,
  type Webhook as WebhookView,
  WebhookEventType,
  WebhookNotFound,
} from "@alias/contracts";
import { Webhook, WebhookUrl } from "@alias/core";
import { WebhookRepo } from "@alias/db";
import { Delivery, Secrets, UrlPolicy } from "@alias/webhooks";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpApiBuilder } from "effect/http-api";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** Endpoints per user. Each costs every published event of theirs one more SQS message. */
const MAX_WEBHOOKS = 10;

const view = (
  webhook: Pick<WebhookRepo.Webhook, "id" | "url" | "eventTypes" | "isEnabled" | "createdAt">,
): WebhookView => ({
  id: webhook.id,
  url: webhook.url,
  eventTypes: Arr.filter(webhook.eventTypes, Schema.is(WebhookEventType)),
  isEnabled: webhook.isEnabled,
  createdAt: webhook.createdAt,
});

const notFound = (webhookId: string) => () => Effect.fail(new WebhookNotFound({ webhookId }));

const create = Effect.fn("webhooks.create")(function* (payload: {
  readonly url: string;
  readonly eventTypes: ReadonlyArray<WebhookEventType>;
}) {
  const user = yield* CurrentUser;
  const policy = yield* UrlPolicy.UrlPolicy;
  const webhooks = yield* WebhookRepo.WebhookRepo;
  const crypto = yield* Crypto.Crypto;
  const url = WebhookUrl.check(payload.url.trim(), policy);
  if (Result.isFailure(url)) return yield* new InvalidWebhookUrl({ reason: url.failure });
  // Not atomic: two concurrent creates may pass at 9. The cap bounds fan-out, not billing.
  if ((yield* Effect.orDie(webhooks.list(user.userId))).length >= MAX_WEBHOOKS) {
    return yield* new TooManyWebhooks({ limit: MAX_WEBHOOKS });
  }
  const owner = {
    userId: user.userId,
    webhookId: `wh_${(yield* Effect.orDie(crypto.randomULID)).toLowerCase()}`,
  };
  // Shown once, here; stored only sealed (SR-13).
  const secret = yield* Webhook.newSecret().pipe(Effect.orDie);
  const webhook = {
    id: owner.webhookId,
    userId: user.userId,
    url: url.success.href,
    eventTypes: Arr.dedupe(payload.eventTypes),
    sealedSecret: yield* Effect.orDie(Secrets.seal(owner, Redacted.make(secret))),
    createdAt: yield* DateTime.now,
  };
  yield* Effect.orDie(webhooks.create(webhook));
  return { ...view({ ...webhook, isEnabled: true }), secret };
});

const rotateSecret = Effect.fn("webhooks.rotateSecret")(function* (webhookId: string) {
  const user = yield* CurrentUser;
  const webhooks = yield* WebhookRepo.WebhookRepo;
  const secret = yield* Webhook.newSecret().pipe(Effect.orDie);
  const sealed = yield* Effect.orDie(
    Secrets.seal({ userId: user.userId, webhookId }, Redacted.make(secret)),
  );
  const until = DateTime.addDuration(yield* DateTime.now, Delivery.ROTATION_GRACE);
  const rotated = yield* webhooks
    .rotateSecret(user.userId, webhookId, sealed, until)
    .pipe(Effect.catchTags({ NoSuchWebhook: notFound(webhookId), DatabaseError: Effect.die }));
  return { ...view(rotated), secret };
});

/** What the webhook handlers use. The group captures them once, at startup. */
type WebhookServices =
  | Crypto.Crypto
  | WebhookRepo.WebhookRepo
  | UrlPolicy.UrlPolicy
  | Secrets.WebhookKeys;

export const WebhooksLive = HttpApiBuilder.group(Api, "webhooks", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<WebhookServices>();
    const webhooks = yield* WebhookRepo.WebhookRepo;
    return handlers
      .handle("list", () =>
        Effect.service(CurrentUser).pipe(
          Effect.flatMap((user) => Effect.orDie(webhooks.list(user.userId))),
          Effect.map(Arr.map(view)),
        ),
      )
      .handle("create", ({ payload }) => Effect.provide(create(payload), services))
      .handle("update", ({ params, payload }) =>
        Effect.service(CurrentUser).pipe(
          Effect.flatMap((user) => webhooks.update(user.userId, params.webhookId, payload)),
          Effect.map(view),
          Effect.catchTags({
            NoSuchWebhook: notFound(params.webhookId),
            DatabaseError: Effect.die,
          }),
        ),
      )
      .handle("rotateSecret", ({ params }) =>
        Effect.provide(rotateSecret(params.webhookId), services),
      )
      .handle("remove", ({ params }) =>
        Effect.service(CurrentUser).pipe(
          Effect.flatMap((user) => webhooks.delete(user.userId, params.webhookId)),
          Effect.catchTags({
            NoSuchWebhook: notFound(params.webhookId),
            DatabaseError: Effect.die,
          }),
        ),
      );
  }),
);
