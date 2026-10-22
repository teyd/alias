import { Transport } from "@alias/aws";
import { SharedDomains } from "@alias/core";
import { Dynamo } from "@alias/db";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as ReverseKeys from "./ReverseKeys.ts";
import * as Spool from "./Spool.ts";

/**
 * The inbound Lambda's environment: `ALIAS_TABLE_NAME`, `ALIAS_SPOOL_BUCKET`,
 * `ALIAS_SHARED_DOMAINS` and `ALIAS_REVERSE_TOKEN_KEYS_PARAMETER`, plus the AWS-standard endpoint
 * overrides that only emulated runs set. A bad value fails the cold start.
 */
export const ServicesConfig = Config.all([
  Dynamo.config,
  Transport.config,
  Spool.config,
  SharedDomains.config.pipe(
    Config.map((domains) => Layer.succeed(SharedDomains.SharedDomains, domains)),
  ),
  ReverseKeys.config,
]).pipe(Config.map((layers) => Layer.mergeAll(...layers)));
