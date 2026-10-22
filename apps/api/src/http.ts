import { Api, openApiDocument } from "@alias/contracts";
import {
  AccountRepo,
  AliasRepo,
  ChallengeRepo,
  ContactRepo,
  DeviceRepo,
  DomainRepo,
  type Dynamo,
  OAuthRepo,
  PasskeyRepo,
  RecipientRepo,
  SessionRepo,
  TokenRepo,
  UserRepo,
  WebhookRepo,
} from "@alias/db";
import { Egress, Publisher, type UrlPolicy } from "@alias/webhooks";
import { NodeCrypto } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import * as Layer from "effect/Layer";
import type { Identities, MessageQueue, Transport } from "@alias/aws";
import type { SharedDomains } from "@alias/core";
import type { Doh } from "@alias/dns";
import { AliasesLive } from "./aliases.ts";
import { AccountLive, AuthLive } from "./auth.ts";
import { ContactsLive } from "./contacts.ts";
import { DeviceLive, OAuthLive } from "./device.ts";
import { DomainsLive } from "./domains.ts";
import type { MailSettings } from "./MailSettings.ts";
import { ConsentLive } from "./consent.ts";
import * as OAuthEndpoints from "./oauth/Endpoints.ts";
import * as Issuer from "./oauth/Issuer.ts";
import { RecipientsLive } from "./recipients.ts";
import type { RelyingParty } from "./RelyingParty.ts";
import { authenticationLayer } from "./Authentication.ts";
import { SettingsLive } from "./settings.ts";
import { TokensLive } from "./tokens.ts";
import { WebhooksLive } from "./webhooks.ts";

const SystemLive = HttpApiBuilder.group(Api, "system", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
);

/** The OpenAPI document, public like the API's shape itself (it's in the repo). */
const OpenApiLive = HttpRouter.add(
  "GET",
  "/v1/openapi.json",
  HttpServerResponse.jsonUnsafe(openApiDocument),
);

const Repositories = Layer.mergeAll(
  AccountRepo.layer,
  AliasRepo.layer,
  ContactRepo.layer,
  DeviceRepo.layer,
  OAuthRepo.layer,
  UserRepo.layer,
  PasskeyRepo.layer,
  SessionRepo.layer,
  ChallengeRepo.layer,
  RecipientRepo.layer,
  TokenRepo.layer,
  WebhookRepo.layer,
  DomainRepo.layer,
);

/**
 * What callers provide: the database, the WebAuthn relying party, the shared domains, outgoing
 * mail, the webhook queue and URL policy, SES identities and a DNS resolver (custom domains).
 */
export type Services =
  | Dynamo.Database
  | RelyingParty
  | SharedDomains.SharedDomains
  | Transport.Transport
  | MailSettings
  | MessageQueue.MessageQueue
  | UrlPolicy.UrlPolicy
  | Identities.Identities
  | Doh.Resolver;

/**
 * The full HTTP app. Callers provide {@link Services}: real DynamoDB and SES in Lambda, emulators
 * elsewhere.
 */
const ApiLive = Layer.mergeAll(HttpApiBuilder.layer(Api), OpenApiLive, OAuthEndpoints.routes).pipe(
  Layer.provide([
    SystemLive,
    AuthLive,
    AccountLive,
    AliasesLive,
    ContactsLive,
    RecipientsLive,
    SettingsLive,
    TokensLive,
    OAuthLive,
    WebhooksLive,
    ConsentLive,
    DeviceLive,
    DomainsLive,
  ]),
  Layer.provide(authenticationLayer),
  // Client metadata documents are fetched through the same SSRF guard as webhooks.
  Layer.provide(Layer.mergeAll(Repositories, Publisher.layer, Issuer.layer, Egress.layer)),
  Layer.provide([HttpServer.layerServices, NodeCrypto.layer]),
);

export const webHandler = <E>(services: Layer.Layer<Services, E>) =>
  HttpRouter.toWebHandler(ApiLive.pipe(Layer.provide(services)), { disableLogger: true });
