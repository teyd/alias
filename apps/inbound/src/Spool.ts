import { AwsClient, Inbound } from "@alias/aws";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The S3 bucket where SES stores received mail, bound to its own AWS client. */
export class Spool extends Context.Service<
  Spool,
  {
    readonly read: (
      messageId: string,
    ) => Effect.Effect<Uint8Array, Inbound.MessageGone | Inbound.SpoolError>;
    readonly delete: (messageId: string) => Effect.Effect<void, Inbound.SpoolError>;
  }
>()("@alias/inbound/Spool") {}

const make = Effect.fn("Spool.make")(function* (bucket: string) {
  const client = yield* Effect.context<AwsClient.AwsClient>();
  return Spool.of({
    read: (messageId) => Inbound.readMessage(bucket, messageId).pipe(Effect.provide(client)),
    delete: (messageId) => Inbound.deleteMessage(bucket, messageId).pipe(Effect.provide(client)),
  });
});

export const layer = (bucket: string): Layer.Layer<Spool, never, AwsClient.AwsClient> =>
  Layer.effect(Spool, make(bucket));

/**
 * `ALIAS_SPOOL_BUCKET`, and `AWS_ENDPOINT_URL_S3` (the AWS-standard endpoint override) only in
 * emulated runs.
 */
export const config = Config.all({
  bucket: Config.String("ALIAS_SPOOL_BUCKET"),
  endpoint: Config.option(Config.String("AWS_ENDPOINT_URL_S3")),
}).pipe(
  Config.map(({ bucket, endpoint }) =>
    layer(bucket).pipe(Layer.provide(AwsClient.layer({ region: AwsClient.region, endpoint }))),
  ),
);
