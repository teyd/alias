import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelyingParty } from "../RelyingParty.ts";

/**
 * Where the authorization server and the MCP resource live (PLAN.md §20.24). Both sit on the web
 * app's origin, like the API: the issuer is the origin itself, the authorization endpoint a page
 * of the web app, the protocol endpoints under `/v1/oauth`, and the one protected resource the
 * MCP endpoint, `<origin>/mcp`, which every token is bound to (RFC 8707).
 */
export class Issuer extends Context.Service<
  Issuer,
  {
    readonly issuer: string;
    /** The canonical URI of the MCP server, every token's audience. */
    readonly resource: string;
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly registrationEndpoint: string;
    readonly revocationEndpoint: string;
    readonly deviceAuthorizationEndpoint: string;
  }
>()("@alias/api/oauth/Issuer") {}

const make = (origin: string): Issuer["Service"] => ({
  issuer: origin,
  resource: `${origin}/mcp`,
  authorizationEndpoint: `${origin}/oauth/authorize`,
  tokenEndpoint: `${origin}/v1/oauth/token`,
  registrationEndpoint: `${origin}/v1/oauth/register`,
  revocationEndpoint: `${origin}/v1/oauth/revoke`,
  deviceAuthorizationEndpoint: `${origin}/v1/oauth/device_authorization`,
});

/** The issuer of the web app's origin, the one passkeys are bound to too. */
export const layer = Layer.effect(
  Issuer,
  Effect.map(Effect.service(RelyingParty), ({ origin }) => make(origin)),
);

/** How long an authorization code may wait for its client: enough for a slow redirect. */
export const CODE_LIFETIME = Duration.minutes(5);
/** Access tokens are short-lived (MCP authorization spec, "Token Theft"). */
export const ACCESS_LIFETIME = Duration.hours(1);
/** Each refresh extends the grant; one unused for this long lapses. */
export const REFRESH_LIFETIME = Duration.days(30);

/** Secret prefixes, so secret scanners can tell a leaked code or token apart from noise. */
export const PREFIX = {
  code: "alias_oac_",
  access: "alias_oat_",
  refresh: "alias_ort_",
} as const;
