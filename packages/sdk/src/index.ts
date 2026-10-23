/**
 * @alias/sdk: a typed client for the Alias API, plus the API contract's errors and schemas.
 *
 * Without Effect, run each call as a promise; it rejects with the endpoint's typed error:
 *
 * ```ts
 * const client = await Effect.runPromise(
 *   AliasClient.make({ baseUrl, token: Redacted.make(token) }).pipe(Effect.provide(FetchHttpClient.layer)),
 * );
 * const aliases = await Effect.runPromise(client.aliases.list());
 * ```
 */
export * as AliasClient from "./AliasClient.ts";
export * as CodeLogin from "./CodeLogin.ts";
export * as DeviceLogin from "./DeviceLogin.ts";
export * from "@alias/contracts";
