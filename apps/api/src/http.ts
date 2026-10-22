import { Api } from "@alias/contracts";
import {
  AccountRepo,
  AliasRepo,
  ChallengeRepo,
  ContactRepo,
  type Dynamo,
  PasskeyRepo,
  RecipientRepo,
  SessionRepo,
  TokenRepo,
  UserRepo,
  WebhookRepo,
} from "@alias/db";
import { Publisher, type UrlPolicy } from "@alias/webhooks";
import { NodeCrypto } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import * as Layer from "effect/Layer";
import type { MessageQueue, Transport } from "@alias/aws";
import type { SharedDomains } from "@alias/core";
import { AliasesLive } from "./aliases.ts";
import { AccountLive, AuthLive } from "./auth.ts";
import { ContactsLive } from "./contacts.ts";
import type { MailSettings } from "./MailSettings.ts";
import { RecipientsLive } from "./recipients.ts";
import type { RelyingParty } from "./RelyingParty.ts";
import { authenticationLayer } from "./Authentication.ts";
import { SettingsLive } from "./settings.ts";
import { TokensLive } from "./tokens.ts";
import { WebhooksLive } from "./webhooks.ts";

const SystemLive = HttpApiBuilder.group(Api, "system", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
);

const Repositories = Layer.mergeAll(
  AccountRepo.layer,
  AliasRepo.layer,
  ContactRepo.layer,
  UserRepo.layer,
  PasskeyRepo.layer,
  SessionRepo.layer,
  ChallengeRepo.layer,
  RecipientRepo.layer,
  TokenRepo.layer,
  WebhookRepo.layer,
);

/**
 * What callers provide: the database, the WebAuthn relying party, the shared domains, outgoing
 * mail, and the webhook queue and URL policy.
 */
export type Services =
  | Dynamo.Database
  | RelyingParty
  | SharedDomains.SharedDomains
  | Transport.Transport
  | MailSettings
  | MessageQueue.MessageQueue
  | UrlPolicy.UrlPolicy;

/**
 * The full HTTP app. Callers provide {@link Services}: real DynamoDB and SES in Lambda, emulators
 * elsewhere.
 */
const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([
    SystemLive,
    AuthLive,
    AccountLive,
    AliasesLive,
    ContactsLive,
    RecipientsLive,
    SettingsLive,
    TokensLive,
    WebhooksLive,
  ]),
  Layer.provide(authenticationLayer),
  Layer.provide(Layer.merge(Repositories, Publisher.layer)),
  Layer.provide([HttpServer.layerServices, NodeCrypto.layer]),
);

export const webHandler = <E>(services: Layer.Layer<Services, E>) =>
  HttpRouter.toWebHandler(ApiLive.pipe(Layer.provide(services)), { disableLogger: true });
