import { MessageQueue, Transport } from "@alias/aws";
import { SharedDomains, TempDomains } from "@alias/core";
import { Dynamo } from "@alias/db";
import { Inbox } from "@alias/inbox";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as ImageProxySigner from "./ImageProxySigner.ts";
import * as ReverseKeys from "./ReverseKeys.ts";
import * as Spool from "./Spool.ts";

/**
 * The inbound Lambda's environment: `ALIAS_TABLE_NAME`, `ALIAS_SPOOL_BUCKET`,
 * `ALIAS_SHARED_DOMAINS`, `ALIAS_REVERSE_TOKEN_KEYS_PARAMETER`, `ALIAS_WEBHOOK_QUEUE_URL`,
 * `ALIAS_IMAGE_PROXY_URL`, `ALIAS_IMAGE_PROXY_KEYS_PARAMETER`, `ALIAS_TEMP_DOMAINS` (optional),
 * `ALIAS_INBOX_BUCKET` and `ALIAS_INBOX_KEYS_PARAMETER`, plus the AWS-standard endpoint
 * overrides that only emulated runs set. A bad value fails the cold start.
 */
export const ServicesConfig = Config.all([
  Config.all({ database: Dynamo.config, inbox: Inbox.config }).pipe(
    Config.map(({ database, inbox }) => Layer.merge(database, Inbox.fromConfig(inbox, database))),
  ),
  Transport.config,
  Spool.config,
  SharedDomains.config.pipe(
    Config.map((domains) => Layer.succeed(SharedDomains.SharedDomains, domains)),
  ),
  ReverseKeys.config,
  MessageQueue.config("ALIAS_WEBHOOK_QUEUE_URL"),
  ImageProxySigner.config,
  TempDomains.config.pipe(Config.map((domains) => Layer.succeed(TempDomains.TempDomains, domains))),
]).pipe(Config.map((layers) => Layer.mergeAll(...layers)));
