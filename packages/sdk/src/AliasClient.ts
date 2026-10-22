import { Api } from "@alias/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";

export interface Options {
  /** Where the API answers, e.g. `https://alias.example` (the web app's origin). */
  readonly baseUrl: string;
  /** A personal API token (`alias_pat_…`), sent as `Authorization: Bearer`. */
  readonly token: Redacted.Redacted<string>;
}

/**
 * The typed client: one method per endpoint, grouped like the API (`client.aliases.list()`),
 * failing with the endpoint's declared errors (`AliasNotFound`, `Forbidden`, …). Needs an
 * `HttpClient` (`FetchHttpClient.layer` works everywhere `fetch` does).
 */
export const make = (options: Options) =>
  HttpApiClient.make(Api, {
    baseUrl: options.baseUrl,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(options.token)),
  });

/** @public */
export type Client = Effect.Success<ReturnType<typeof make>>;

/** @public The client as a service, for programs that provide it once with {@link layer}. */
export class AliasClient extends Context.Service<AliasClient, Client>()("@alias/sdk/AliasClient") {}

/** @public */
export const layer = (options: Options) => Layer.effect(AliasClient, make(options));
