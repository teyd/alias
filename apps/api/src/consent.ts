import { Api, type ConnectedApp, ConnectedAppNotFound, CurrentUser, Scope } from "@alias/contracts";
import { OAuthRepo } from "@alias/db";
import type { UrlPolicy } from "@alias/webhooks";
import * as Arr from "effect/Array";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import * as Schema from "effect/Schema";
import * as Authorize from "./oauth/Authorize.ts";
import type { Issuer } from "./oauth/Issuer.ts";

const view = (grant: OAuthRepo.Grant): ConnectedApp => ({
  id: grant.id,
  clientId: grant.clientId,
  clientName: grant.clientName,
  scopes: Arr.filter(grant.scopes, Schema.is(Scope)),
  createdAt: grant.createdAt,
});

/** What the consent handlers use. The group captures them once, at startup. */
type OAuthServices =
  | Crypto.Crypto
  | Issuer
  | OAuthRepo.OAuthRepo
  | HttpClient.HttpClient
  | UrlPolicy.UrlPolicy;

export const ConsentLive = HttpApiBuilder.group(Api, "consent", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<OAuthServices>();
    const repo = yield* OAuthRepo.OAuthRepo;
    return handlers
      .handle("inspect", ({ payload }) => Effect.provide(Authorize.inspect(payload), services))
      .handle("decide", ({ payload }) =>
        Effect.provide(
          Effect.map(Authorize.decide(payload), (redirectTo) => ({ redirectTo })),
          services,
        ),
      )
      .handle("grants", () =>
        Effect.service(CurrentUser).pipe(
          Effect.flatMap((user) => Effect.orDie(repo.listGrants(user.userId))),
          Effect.map(Arr.map(view)),
        ),
      )
      .handle("revoke", ({ params }) =>
        Effect.service(CurrentUser).pipe(
          Effect.flatMap((user) => repo.revokeUserGrant(user.userId, params.grantId)),
          Effect.catchTags({
            NoSuchGrant: () => Effect.fail(new ConnectedAppNotFound({ grantId: params.grantId })),
            DatabaseError: Effect.die,
          }),
        ),
      );
  }),
);
