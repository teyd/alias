import { Dynamo } from "@alias/db";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as RelyingParty from "./RelyingParty.ts";

/**
 * Lambda environment. The service runs in eu-west-1 only. `AWS_ENDPOINT_URL_DYNAMODB` is the
 * AWS-standard endpoint override; only emulated runs (dev, tests) set it.
 */
const DatabaseConfig = Config.all({
  tableName: Config.String("ALIAS_TABLE_NAME"),
  endpoint: Config.option(Config.String("AWS_ENDPOINT_URL_DYNAMODB")),
}).pipe(
  Config.map(({ tableName, endpoint }) =>
    Dynamo.layer({ tableName, region: "eu-west-1", endpoint }),
  ),
);

/** Passkeys are bound to `ALIAS_RP_ID` (e.g. `alias.example`) and the web app's exact origin. */
const RelyingPartyConfig = Config.all({
  id: Config.String("ALIAS_RP_ID"),
  origin: Config.String("ALIAS_WEB_ORIGIN"),
}).pipe(Config.map(RelyingParty.layer));

export const ServicesConfig = Config.all([DatabaseConfig, RelyingPartyConfig]).pipe(
  Config.map(([database, relyingParty]) => Layer.merge(database, relyingParty)),
);
