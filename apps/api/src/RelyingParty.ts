import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/**
 * The WebAuthn relying party: the site passkeys are bound to. `id` is its registrable domain
 * (`alias.example`, or `localhost` in dev) and `origin` the exact web origin the browser reports.
 */
export class RelyingParty extends Context.Service<
  RelyingParty,
  { readonly id: string; readonly name: string; readonly origin: string }
>()("@alias/api/RelyingParty") {}

export const layer = (config: { readonly id: string; readonly origin: string }) =>
  Layer.succeed(RelyingParty, RelyingParty.of({ ...config, name: "Alias" }));
