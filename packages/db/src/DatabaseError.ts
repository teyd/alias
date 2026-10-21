import * as Schema from "effect/Schema";

/** Any DynamoDB failure the caller can't act on (throttling, network, a corrupt item…). */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
  reason: Schema.String,
}) {}

export const databaseError = (operation: string) => (cause: unknown) =>
  new DatabaseError({ operation, reason: String(cause) });
