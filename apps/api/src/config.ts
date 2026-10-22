import { Identities, MessageQueue, Transport } from "@alias/aws";
import { SharedDomains, TempDomains } from "@alias/core";
import { Dynamo } from "@alias/db";
import { Doh } from "@alias/dns";
import { Inbox } from "@alias/inbox";
import { UrlPolicy } from "@alias/webhooks";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MailSettings from "./MailSettings.ts";
import * as RelyingParty from "./RelyingParty.ts";

/** Passkeys are bound to `ALIAS_RP_ID` (e.g. `alias.example`) and the web app's exact origin. */
const RelyingPartyConfig = Config.all({
  id: Config.String("ALIAS_RP_ID"),
  origin: Config.String("ALIAS_WEB_ORIGIN"),
}).pipe(Config.map(RelyingParty.layer));

/**
 * The shared domains (`ALIAS_SHARED_DOMAINS`, see `SharedDomains.config`) and the confirmation
 * sender `ALIAS_CONFIRMATION_FROM`, which must be an address on one of them (default
 * `no-reply@<first shared domain>`). A bad value fails the cold start, not every request.
 */
const MailConfig = Config.all({
  domains: SharedDomains.config,
  sender: Config.option(Config.String("ALIAS_CONFIRMATION_FROM")),
}).pipe(
  Config.mapEffect(({ domains, sender }) => {
    const shared = Layer.succeed(SharedDomains.SharedDomains, domains);
    return MailSettings.make(sender).pipe(
      Effect.provide(shared),
      Effect.map((settings) =>
        Layer.merge(shared, Layer.succeed(MailSettings.MailSettings, settings)),
      ),
      Effect.mapError(
        (error) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: `ALIAS_CONFIRMATION_FROM ${error.sender}: ${error.reason}`,
            }),
          ),
      ),
    );
  }),
);

/** The table, and the inbox store on it (its keys are read when the layer is built). */
const StorageConfig = Config.all({ database: Dynamo.config, inbox: Inbox.config }).pipe(
  Config.map(({ database, inbox }) => Layer.merge(database, Inbox.fromConfig(inbox, database))),
);

export const ServicesConfig = Config.all([
  StorageConfig,
  TempDomains.config.pipe(Config.map((domains) => Layer.succeed(TempDomains.TempDomains, domains))),
  RelyingPartyConfig,
  Transport.config,
  MailConfig,
  MessageQueue.config("ALIAS_WEBHOOK_QUEUE_URL"),
  UrlPolicy.config,
  Identities.config,
  Doh.config,
]).pipe(Config.map((layers) => Layer.mergeAll(...layers)));
