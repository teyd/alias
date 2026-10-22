import { Api } from "@alias/contracts";
import {
  AliasRepo,
  ChallengeRepo,
  type Dynamo,
  PasskeyRepo,
  RecipientRepo,
  SessionRepo,
  UserRepo,
} from "@alias/db";
import { NodeCrypto } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import * as Layer from "effect/Layer";
import type { Transport } from "@alias/aws";
import { AliasesLive } from "./aliases.ts";
import { AccountLive, AuthLive } from "./auth.ts";
import type { MailSettings } from "./MailSettings.ts";
import { RecipientsLive } from "./recipients.ts";
import type { RelyingParty } from "./RelyingParty.ts";
import { authenticationLayer } from "./Sessions.ts";
import type { SharedDomains } from "./SharedDomains.ts";

const SystemLive = HttpApiBuilder.group(Api, "system", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
);

const Repositories = Layer.mergeAll(
  AliasRepo.layer,
  UserRepo.layer,
  PasskeyRepo.layer,
  SessionRepo.layer,
  ChallengeRepo.layer,
  RecipientRepo.layer,
);

/** What callers provide: the database, the WebAuthn relying party, the shared domains and outgoing mail. */
export type Services =
  | Dynamo.Database
  | RelyingParty
  | SharedDomains
  | Transport.Transport
  | MailSettings;

/**
 * The full HTTP app. Callers provide {@link Services}: real DynamoDB and SES in Lambda, emulators
 * elsewhere.
 */
const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([SystemLive, AuthLive, AccountLive, AliasesLive, RecipientsLive]),
  Layer.provide(authenticationLayer),
  Layer.provide(Repositories),
  Layer.provide([HttpServer.layerServices, NodeCrypto.layer]),
);

export const webHandler = <E>(services: Layer.Layer<Services, E>) =>
  HttpRouter.toWebHandler(ApiLive.pipe(Layer.provide(services)), { disableLogger: true });
