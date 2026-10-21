import { AliasNotFound, Api, CurrentUser } from "@alias/contracts";
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
import * as Option from "effect/Option";
import { AccountLive, AuthLive } from "./auth.ts";
import type { RelyingParty } from "./RelyingParty.ts";
import { authenticationLayer } from "./Sessions.ts";

const SystemLive = HttpApiBuilder.group(Api, "system", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
);

const AliasesLive = HttpApiBuilder.group(Api, "aliases", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* AliasRepo.AliasRepo;
    return handlers.handle("lookup", ({ params }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const alias = yield* Effect.orDie(repo.findByAddress(params.domain, params.local));
        return yield* Option.match(
          Option.filter(alias, (found) => found.userId === user.userId),
          {
            onNone: () =>
              Effect.fail(new AliasNotFound({ address: `${params.local}@${params.domain}` })),
            onSome: (found) =>
              Effect.succeed({
                id: found.id,
                address: `${found.localPart}@${found.domain}`,
                mode: found.mode,
                isActive: found.isActive,
              }),
          },
        );
      }),
    );
  }),
);

const Repositories = Layer.mergeAll(
  AliasRepo.layer,
  UserRepo.layer,
  PasskeyRepo.layer,
  SessionRepo.layer,
  ChallengeRepo.layer,
);

/**
 * The full HTTP app. Callers provide the database (real DynamoDB in Lambda, an emulator elsewhere)
 * and the WebAuthn relying party.
 */
const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([SystemLive, AuthLive, AccountLive, AliasesLive]),
  Layer.provide(authenticationLayer),
  Layer.provide(Repositories),
  Layer.provide([HttpServer.layerServices, NodeCrypto.layer]),
);

export const webHandler = (services: Layer.Layer<Dynamo.Database | RelyingParty>) =>
  HttpRouter.toWebHandler(ApiLive.pipe(Layer.provide(services)), { disableLogger: true });
