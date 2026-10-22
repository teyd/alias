import { Api } from "@alias/contracts";
import {
  AliasRepo,
  ChallengeRepo,
  type Dynamo,
  PasskeyRepo,
  SessionRepo,
  UserRepo,
} from "@alias/db";
import { NodeCrypto } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import * as Layer from "effect/Layer";
import { AliasesLive } from "./aliases.ts";
import { AccountLive, AuthLive } from "./auth.ts";
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
);

/**
 * The full HTTP app. Callers provide the database (real DynamoDB in Lambda, an emulator elsewhere),
 * the WebAuthn relying party and the shared mail domains.
 */
const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([SystemLive, AuthLive, AccountLive, AliasesLive]),
  Layer.provide(authenticationLayer),
  Layer.provide(Repositories),
  Layer.provide([HttpServer.layerServices, NodeCrypto.layer]),
);

export const webHandler = (services: Layer.Layer<Dynamo.Database | RelyingParty | SharedDomains>) =>
  HttpRouter.toWebHandler(ApiLive.pipe(Layer.provide(services)), { disableLogger: true });
