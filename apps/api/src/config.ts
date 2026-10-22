import { AwsClient, Transport } from "@alias/aws";
import { Dynamo } from "@alias/db";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Str from "effect/String";
import * as MailSettings from "./MailSettings.ts";
import * as RelyingParty from "./RelyingParty.ts";

/**
 * Lambda environment. The service runs in eu-west-1 only. `AWS_ENDPOINT_URL_DYNAMODB` and
 * `AWS_ENDPOINT_URL_SESV2` are the AWS-standard endpoint overrides; only emulated runs set them.
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

const TransportConfig = Config.option(Config.String("AWS_ENDPOINT_URL_SESV2")).pipe(
  Config.map((endpoint) =>
    Transport.ses.pipe(Layer.provide(AwsClient.layer({ region: AwsClient.region, endpoint }))),
  ),
);

/**
 * Confirmation mail is sent as `ALIAS_CONFIRMATION_FROM`, which must be an address on one of the
 * comma-separated `ALIAS_SHARED_DOMAINS`. A bad value fails the cold start, not every request.
 */
const MailConfig = Config.all({
  sender: Config.String("ALIAS_CONFIRMATION_FROM"),
  aliasDomains: Config.String("ALIAS_SHARED_DOMAINS").pipe(Config.map(Str.split(","))),
}).pipe(
  Config.mapEffect((settings) =>
    MailSettings.make(settings).pipe(
      Effect.mapError(
        (error) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: `ALIAS_CONFIRMATION_FROM ${error.sender}: ${error.reason}`,
            }),
          ),
      ),
    ),
  ),
  Config.map((settings) => Layer.succeed(MailSettings.MailSettings, settings)),
);

export const ServicesConfig = Config.all([
  DatabaseConfig,
  RelyingPartyConfig,
  TransportConfig,
  MailConfig,
]).pipe(Config.map((layers) => Layer.mergeAll(...layers)));
