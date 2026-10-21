import { DynamoDbEndpoint } from "@alias/aws-emulators";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Dynamo, Table } from "../../src/index.ts";

let tables = 0;

/**
 * A fresh, empty table on whichever emulator `DynamoEndpoint` points at. Each call uses a new
 * table name, so tests sharing one emulator process never see each other's items.
 */
export const freshTable = () => {
  tables += 1;
  const tableName = `alias_test_${tables}`;
  return Layer.unwrap(
    Effect.map(Effect.service(DynamoDbEndpoint), (endpoint) => {
      const client = Dynamo.emulator(endpoint.url, tableName);
      return Layer.effectDiscard(Table.ensure()).pipe(Layer.provideMerge(client));
    }),
  );
};
