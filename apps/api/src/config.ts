import { Dynamo } from "@alias/db";
import * as Config from "effect/Config";

/**
 * Lambda environment. The service runs in eu-west-1 only. `AWS_ENDPOINT_URL_DYNAMODB` is the
 * AWS-standard endpoint override; only emulated runs (dev, tests) set it.
 */
export const DatabaseConfig = Config.all({
  tableName: Config.String("ALIAS_TABLE_NAME"),
  endpoint: Config.option(Config.String("AWS_ENDPOINT_URL_DYNAMODB")),
}).pipe(
  Config.map(({ tableName, endpoint }) =>
    Dynamo.layer({ tableName, region: "eu-west-1", endpoint }),
  ),
);
