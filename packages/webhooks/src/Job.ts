import { WebhookEvent } from "@alias/contracts";
import * as Schema from "effect/Schema";

/**
 * One delivery to do: an SQS message body, one per event and endpoint. The endpoint's URL and
 * secret aren't in it; delivery reads them, so a deleted, paused or rotated endpoint takes effect
 * for messages already queued.
 */
const Job = Schema.Struct({
  /** `webhook-id`: the same for every attempt, so receivers can deduplicate. */
  id: Schema.String,
  userId: Schema.String,
  webhookId: Schema.String,
  event: WebhookEvent,
});

/** A job as the SQS message body carries it. */
export const JobJson = Schema.fromJsonString(Job);
export type JobJson = typeof JobJson.Type;
