import { Api, CurrentUser } from "@alias/contracts";
import { UserRepo } from "@alias/db";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";

export const SettingsLive = HttpApiBuilder.group(Api, "settings", (handlers) =>
  Effect.gen(function* () {
    const users = yield* UserRepo.UserRepo;
    return handlers
      .handle("get", () =>
        Effect.flatMap(Effect.service(CurrentUser), (user) =>
          Effect.orDie(users.settings(user.userId)),
        ),
      )
      .handle("update", ({ payload }) =>
        Effect.flatMap(Effect.service(CurrentUser), (user) =>
          Effect.orDie(users.updateSettings(user.userId, payload)),
        ),
      );
  }),
);
