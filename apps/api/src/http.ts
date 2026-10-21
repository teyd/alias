import { AliasNotFound, Api } from "@alias/contracts";
import { AliasRepo, type Dynamo } from "@alias/db";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const SystemLive = HttpApiBuilder.group(Api, "system", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
);

const AliasesLive = HttpApiBuilder.group(Api, "aliases", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* AliasRepo.AliasRepo;
    return handlers.handle("lookup", ({ params }) =>
      repo.findByAddress(params.domain, params.local).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new AliasNotFound({ address: `${params.local}@${params.domain}` })),
            onSome: (alias) =>
              Effect.succeed({
                id: alias.id,
                address: `${alias.localPart}@${alias.domain}`,
                mode: alias.mode,
                isActive: alias.isActive,
              }),
          }),
        ),
      ),
    );
  }),
);

/** The full HTTP app. Callers provide the database (real DynamoDB in Lambda, an emulator elsewhere). */
const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([SystemLive, AliasesLive]),
  Layer.provide(AliasRepo.layer),
  Layer.provide(HttpServer.layerServices),
);

export const webHandler = (database: Layer.Layer<Dynamo.Database>) =>
  HttpRouter.toWebHandler(ApiLive.pipe(Layer.provide(database)), { disableLogger: true });
