import { type QueryClient, queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

/**
 * After logging out or erasing the account: signed out, and nothing of the account stays in
 * memory for whoever uses the browser next. `me` itself is overwritten, not removed: screens
 * observing a removed query keep showing its last value, so they'd stay signed in.
 */
export const forgetSession = (queryClient: QueryClient) => {
  queryClient.setQueryData(meQuery.queryKey, Option.none());
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== meQuery.queryKey[0] });
};
