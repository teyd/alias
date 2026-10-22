import { AwsClient, Parameters } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { ReverseToken } from "@alias/core";
import * as SSM from "@distilled.cloud/aws/ssm";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ReverseKeys } from "../src/index.ts";

/**
 * Reverse-token keys from SSM Parameter Store, the way the inbound Lambda loads them at cold
 * start (PLAN.md §20.14), on fakecloud. The parsing rules themselves are in core's `Keyring.test.ts`.
 */
const aws = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), ({ url }) => AwsClient.emulator(url)),
);

const secret = (fill: number) => Buffer.alloc(32, fill).toString("base64url");

const put = (name: string, value: string, type: SSM.ParameterType = "SecureString") =>
  SSM.putParameter({ Name: name, Value: value, Type: type, Overwrite: true });

/** Builds the keys the way `handler.ts` does, from env-style configuration. */
const fromEnv = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const layer = yield* ReverseKeys.config;
    return yield* ReverseKeys.ReverseKeys.pipe(Effect.provide(layer));
  }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })));

const load = (name: string) =>
  ReverseKeys.ReverseKeys.pipe(Effect.provide(ReverseKeys.fromParameter(name)));

describe("ReverseKeys from Parameter Store (fakecloud)", () => {
  it.layer(Layer.mergeAll(aws, NodeCrypto.layer).pipe(Layer.provideMerge(FakeCloud.layer())), {
    timeout: 30_000,
  })((it) => {
    it.effect("reads the parameter that ALIAS_REVERSE_TOKEN_KEYS_PARAMETER names", () =>
      Effect.gen(function* () {
        const { url } = yield* FakeCloud.FakeCloud;
        yield* put("/alias/test/reverse-token-keys", `2:${secret(2)},1:${secret(1)}`);
        const keys = yield* fromEnv({
          ALIAS_REVERSE_TOKEN_KEYS_PARAMETER: "/alias/test/reverse-token-keys",
          AWS_ENDPOINT_URL_SSM: url,
        });
        expect(keys.current.version).toBe(2);
        expect(keys.retired.map((key) => key.version)).toEqual([1]);
      }),
    );

    // A warm container keeps the set it loaded, so during a rotation old and new containers
    // answer side by side. With the two-step rotation each one verifies what the other mints.
    it.effect("lets containers on either step of a rotation verify each other's tokens", () =>
      Effect.gen(function* () {
        const alias = { local: "shop", domain: "alias.test" };
        const subject = "c1aaaaaaaaaaaaaa";

        // Step one: the new key 2 is added after the minting key 1.
        yield* put("/alias/test/rotation", `1:${secret(1)},2:${secret(2)}`);
        const warm = yield* load("/alias/test/rotation");
        // Step two, once every container has step one: key 2 moves to the front.
        yield* put("/alias/test/rotation", `2:${secret(2)},1:${secret(1)}`);
        const fresh = yield* load("/alias/test/rotation");
        expect([warm.current.version, fresh.current.version]).toEqual([1, 2]);

        const fromWarm = yield* ReverseToken.mint(warm, alias, subject);
        const fromFresh = yield* ReverseToken.mint(fresh, alias, subject);
        expect(yield* ReverseToken.verify(fresh, alias, fromWarm)).toEqual(
          yield* ReverseToken.verify(warm, alias, fromWarm),
        );
        expect(yield* ReverseToken.verify(warm, alias, fromFresh)).toEqual(
          yield* ReverseToken.verify(fresh, alias, fromFresh),
        );
      }),
    );

    it.effect("fails on a missing parameter, naming it", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(load("/alias/test/missing"));
        expect(error).toEqual(new Parameters.MissingParameter({ name: "/alias/test/missing" }));
      }),
    );

    it.effect("fails on a bad value without echoing it", () =>
      Effect.gen(function* () {
        const leaked = secret(3).slice(0, 20);
        yield* put("/alias/test/bad", `1:${leaked}`);
        const error = yield* Effect.flip(load("/alias/test/bad"));
        expect(error._tag).toBe("InvalidKeys");
        expect(JSON.stringify(error)).toContain("/alias/test/bad (version 1)");
        expect(JSON.stringify(error)).not.toContain(leaked);
        expect(String(error)).not.toContain(leaked);
      }),
    );

    it.effect("refuses keys stored as a plain String", () =>
      Effect.gen(function* () {
        const value = `1:${secret(4)}`;
        yield* put("/alias/test/plain", value, "String");
        const error = yield* Effect.flip(load("/alias/test/plain"));
        expect(error._tag).toBe("ParameterUnavailable");
        expect(JSON.stringify(error)).not.toContain(secret(4));
      }),
    );
  });
});
