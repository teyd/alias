import { Api } from "@alias/contracts";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

const client = HttpApiClient.make(Api, { baseUrl: window.location.origin });

type Client = Effect.Success<typeof client>;

/** Runs one typed API call; TanStack Query owns caching, retries and loading state. */
export const callApi = <A, E>(call: (api: Client) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(client.pipe(Effect.flatMap(call), Effect.provide(FetchHttpClient.layer)));
