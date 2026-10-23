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
  OutboxRepo,
  PasskeyRepo,
  RecipientRepo,
  SentRepo,
  SessionRepo,
  SignupLimitRepo,
  TokenRepo,
  UserRepo,
  UsernameRepo,
  WebhookRepo,
} from "@alias/db";
import { Egress, Publisher, type Secrets, type UrlPolicy } from "@alias/webhooks";
import { NodeCrypto } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import * as Layer from "effect/Layer";
import type { Identities, MessageQueue, Transport } from "@alias/aws";
import type { SharedDomains, TempDomains } from "@alias/core";
import type { Doh } from "@alias/dns";
import type { Inbox } from "@alias/inbox";
import type { Turnstile } from "@alias/turnstile";
import { AliasesLive } from "./aliases.ts";
import { AccountLive, AuthLive } from "./auth.ts";
import { ContactsLive } from "./contacts.ts";
import { LabelsLive } from "./labels.ts";
import { DeviceLive, OAuthLive } from "./device.ts";
import { DomainsLive } from "./domains.ts";
import { InboxesLive } from "./inboxes.ts";
import type { MailSettings } from "./MailSettings.ts";
import { ConsentLive } from "./consent.ts";
import * as Mcp from "./mcp/Endpoint.ts";
import { OutboxLive } from "./outbox.ts";
import * as OAuthEndpoints from "./oauth/Endpoints.ts";
import * as Issuer from "./oauth/Issuer.ts";
import { RecipientsLive } from "./recipients.ts";
import type { RelyingParty } from "./RelyingParty.ts";
import { authenticationLayer } from "./Authentication.ts";
import { SettingsLive } from "./settings.ts";
import { SecurityLive } from "./security.ts";
import { TokensLive } from "./tokens.ts";
import { UsernamesLive } from "./usernames.ts";
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
  OutboxRepo.layer,
  UserRepo.layer,
  UsernameRepo.layer,
  PasskeyRepo.layer,
  SessionRepo.layer,
  ChallengeRepo.layer,
  SignupLimitRepo.layer,
  RecipientRepo.layer,
  SentRepo.layer,
  TokenRepo.layer,
  WebhookRepo.layer,
  DomainRepo.layer,
);

/**
 * What callers provide: the database, the WebAuthn relying party, the shared and temp-mail
 * domains, outgoing mail, the webhook queue, URL policy and secret keys, SES identities and a DNS
 * resolver (custom domains), the inbox store, and Turnstile (sign-up). They may also provide
 * `SignupLimits`; the defaults apply otherwise.
 */
export type Services =
  | Dynamo.Database
  | RelyingParty
  | SharedDomains.SharedDomains
  | TempDomains.TempDomains
  | Inbox.Inbox
  | Transport.Transport
  | MailSettings
  | MessageQueue.MessageQueue
  | UrlPolicy.UrlPolicy
  | Secrets.WebhookKeys
  | Identities.Identities
  | Doh.Resolver
  | Turnstile.Turnstile;

/**
 * The full HTTP app. Callers provide {@link Services}: real DynamoDB and SES in Lambda, emulators
 * elsewhere.
 */
const ApiLive = Layer.mergeAll(
  HttpApiBuilder.layer(Api),
  OpenApiLive,
  OAuthEndpoints.routes,
  Mcp.routes,
).pipe(
  Layer.provide([
    SystemLive,
    AuthLive,
    AccountLive,
    AliasesLive,
    ContactsLive,
    LabelsLive,
    InboxesLive,
    RecipientsLive,
    SettingsLive,
    UsernamesLive,
    SecurityLive,
    TokensLive,
    OAuthLive,
    OutboxLive,
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
