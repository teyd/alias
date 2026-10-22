import { AwsClient } from "@alias/aws";
import type * as Region from "@distilled.cloud/aws/Region";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";

/** The single application table (see `Table.ts` for its keys and indexes). */
export class DynamoTable extends Context.Service<DynamoTable, { readonly name: string }>()(
  "@alias/db/DynamoTable",
) {}

/** What repositories need: the table plus an AWS client (real or emulated, see `AwsClient`). */
export type Database = DynamoTable | AwsClient.AwsClient;

interface DynamoConfig {
  readonly tableName: string;
  readonly region: Region.RegionName;
  readonly endpoint: Option.Option<string>;
}

const layer = (config: DynamoConfig): Layer.Layer<Database> =>
  Layer.merge(
    Layer.succeed(DynamoTable, DynamoTable.of({ name: config.tableName })),
    AwsClient.layer(config),
  );

export const emulator = (url: string, tableName: string): Layer.Layer<Database> =>
  Layer.merge(
    Layer.succeed(DynamoTable, DynamoTable.of({ name: tableName })),
    AwsClient.emulator(url),
  );

/**
 * The table from the Lambda environment: `ALIAS_TABLE_NAME`, and `AWS_ENDPOINT_URL_DYNAMODB` (the
 * AWS-standard endpoint override) only in emulated runs. The service runs in eu-west-1 only.
 */
export const config = Config.all({
  tableName: Config.String("ALIAS_TABLE_NAME"),
  endpoint: Config.option(Config.String("AWS_ENDPOINT_URL_DYNAMODB")),
}).pipe(
  Config.map(({ tableName, endpoint }) => layer({ tableName, region: AwsClient.region, endpoint })),
);
