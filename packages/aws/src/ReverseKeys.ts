import { Keyring } from "@alias/core";
import * as SSM from "@distilled.cloud/aws/ssm";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Redacted from "effect/Redacted";
import * as AwsClient from "./Client.ts";
import * as Parameters from "./Parameters.ts";

/**
 * The keys that sign and check reverse-alias tokens (`ReverseToken` in `@alias/core`): the inbound
 * Lambda verifies replies with them, the API mints the reverse alias of a contact the owner adds
 * (PLAN.md §20.33).
 */
export class ReverseKeys extends Context.Service<ReverseKeys, Keyring.Keyring>()(
  "@alias/aws/ReverseKeys",
) {}

/** Keys given as a value: tests and `bin/`. */
export const layer = (value: Redacted.Redacted<string>) =>
  Layer.effect(ReverseKeys, Keyring.parse(value));

/** The keys from a `SecureString` in SSM Parameter Store (`Parameters.keyring`, PLAN.md §20.14). */
export const fromParameter = (name: string) => Layer.effect(ReverseKeys, Parameters.keyring(name));

/** `ALIAS_REVERSE_TOKEN_KEYS_PARAMETER`: the parameter's name (`Parameters.keyringConfig`). */
export const config = Parameters.keyringConfig("ALIAS_REVERSE_TOKEN_KEYS_PARAMETER").pipe(
  Config.map((load) => Layer.effect(ReverseKeys, load)),
);

const DEV_KEYS = "1:ZGV2LW9ubHktcmV2ZXJzZS10b2tlbi1rZXktbm90LXNlY3JldA";
const DEV_PARAMETER = "/alias/dev/reverse-token-keys";

/**
 * The keys for `pnpm dev` on fakecloud at `url`, shared by the API and the inbound Lambda: fixed
 * dev keys put into fakecloud's SSM as `/alias/dev/reverse-token-keys` unless that parameter
 * exists, then read back the way the Lambdas read theirs. Anyone with this repo knows them: never
 * use them anywhere real.
 */
export const dev = (url: string) =>
  Layer.unwrap(
    SSM.putParameter({ Name: DEV_PARAMETER, Type: "SecureString", Value: DEV_KEYS }).pipe(
      Effect.catchTag("ParameterAlreadyExists", () => Effect.void),
      // fakecloud starts alongside.
      Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
      Effect.as(fromParameter(DEV_PARAMETER)),
    ),
  ).pipe(Layer.provide(AwsClient.emulator(url)));
