import { Parameters } from "@alias/aws";
import { Keyring } from "@alias/core";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

/** The keys that sign and check reverse-alias tokens (`ReverseToken` in `@alias/core`). */
export class ReverseKeys extends Context.Service<ReverseKeys, Keyring.Keyring>()(
  "@alias/inbound/ReverseKeys",
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
