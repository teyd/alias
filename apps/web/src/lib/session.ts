import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import { callApi } from "./api";

/** Who is signed in: `Option.none()` when the session cookie is missing or no longer valid. */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () =>
    callApi((api) =>
      api.account.me().pipe(
        Effect.asSome,
        Effect.catchTag("Unauthenticated", () => Effect.succeedNone),
      ),
    ),
});
