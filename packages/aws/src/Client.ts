import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import * as Region from "@distilled.cloud/aws/Region";
import { FetchHttpClient, type HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/** What every `@distilled.cloud/aws` call needs at runtime. */
export type AwsClient = Credentials.Credentials | HttpClient.HttpClient;

export interface ClientConfig {
  readonly region: Region.RegionName;
  /**
   * Emulator URL. When set, every request goes there with fixed dummy credentials. When absent,
   * requests go to the real regional endpoints with credentials from the environment (what the
   * Lambda runtime provides).
   */
  readonly endpoint: Option.Option<string>;
}

const emulatorCredentials = {
  accessKeyId: Redacted.make("local"),
  secretAccessKey: Redacted.make("local"),
};

/** The one place that decides between real AWS and an emulator. */
export const layer = (config: ClientConfig): Layer.Layer<AwsClient> =>
  Layer.mergeAll(
    FetchHttpClient.layer,
    Region.of(config.region),
    Option.match(config.endpoint, {
      onNone: () => Credentials.fromEnv(),
      onSome: (url) =>
        Layer.merge(
          Credentials.fromCredentials(emulatorCredentials, config.region),
          Endpoint.of(url),
        ),
    }),
  );

/** The service runs in eu-west-1 only. */
export const region: Region.RegionName = "eu-west-1";

/** Shorthand for an emulator endpoint. */
export const emulator = (url: string) => layer({ region, endpoint: Option.some(url) });
