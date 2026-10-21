import { AwsClient } from "@alias/aws";
import type * as Region from "@distilled.cloud/aws/Region";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";

/** The single application table (see `Table.ts` for its keys and indexes). */
export class DynamoTable extends Context.Service<DynamoTable, { readonly name: string }>()(
  "@alias/db/DynamoTable",
) {}

/** What repositories need: the table plus an AWS client (real or emulated, see `AwsClient`). */
export type Database = DynamoTable | AwsClient.AwsClient;

export interface DynamoConfig {
  readonly tableName: string;
  readonly region: Region.RegionName;
  readonly endpoint: Option.Option<string>;
}

export const layer = (config: DynamoConfig): Layer.Layer<Database> =>
  Layer.merge(
    Layer.succeed(DynamoTable, DynamoTable.of({ name: config.tableName })),
    AwsClient.layer(config),
  );

/** The table on an emulator endpoint. */
export const emulator = (url: string, tableName: string): Layer.Layer<Database> =>
  Layer.merge(
    Layer.succeed(DynamoTable, DynamoTable.of({ name: tableName })),
    AwsClient.emulator(url),
  );
