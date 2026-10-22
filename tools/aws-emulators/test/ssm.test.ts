import { AwsClient, Parameters } from "@alias/aws";
import response from "@alias/aws/fixtures/ssm-get-parameter-response.json" with { type: "json" };
import * as SSM from "@distilled.cloud/aws/ssm";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FakeCloud } from "../src/index.ts";

const client = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), ({ url }) => AwsClient.emulator(url)),
);

const put = (name: string, value: string, type: SSM.ParameterType = "SecureString") =>
  SSM.putParameter({ Name: name, Value: value, Type: type, Overwrite: true });

// The inbound Lambda reads its reverse-token keys this way at cold start (PLAN.md §20.14).
describe("SSM Parameter Store on fakecloud", () => {
  it.layer(client.pipe(Layer.provideMerge(FakeCloud.layer())), { timeout: 30_000 })((it) => {
    it.effect("returns a SecureString decrypted, with the documented fields and version", () =>
      Effect.gen(function* () {
        const put1 = yield* put("/alias/test/keys", "first");
        expect(put1.Version).toBe(1);
        const raw = yield* SSM.getParameter({ Name: "/alias/test/keys", WithDecryption: true });
        // Exactly the fields of the documented response (`ssm-get-parameter-response.json`);
        // `Selector` and `SourceResult` only come with a `name:version` or shared-parameter lookup.
        expect(raw.Parameter).toStrictEqual({
          ARN: expect.any(String),
          DataType: response.Parameter.DataType,
          LastModifiedDate: expect.any(Date),
          Name: "/alias/test/keys",
          Type: response.Parameter.Type,
          Value: expect.anything(),
          Version: 1,
        });
        // A leading slash isn't doubled in the ARN, the form the infra's IAM policy names.
        expect(raw.Parameter?.ARN).toMatch(
          /^arn:aws:ssm:eu-west-1:\d{12}:parameter\/alias\/test\/keys$/,
        );

        const first = yield* Parameters.secureString("/alias/test/keys");
        expect(Redacted.value(first.value)).toBe("first");
        expect(first.version).toBe(1);

        yield* put("/alias/test/keys", "second");
        const second = yield* Parameters.secureString("/alias/test/keys");
        expect(Redacted.value(second.value)).toBe("second");
        expect(second.version).toBe(2);
      }),
    );

    it.effect("answers a missing name with ParameterNotFound", () =>
      Effect.gen(function* () {
        const raw = yield* Effect.flip(SSM.getParameter({ Name: "/alias/test/none" }));
        expect(raw._tag).toBe("ParameterNotFound");
        expect(yield* Effect.flip(Parameters.secureString("/alias/test/none"))).toEqual(
          new Parameters.MissingParameter({ name: "/alias/test/none" }),
        );
      }),
    );

    it.effect("refuses a plain String parameter without naming its value", () =>
      Effect.gen(function* () {
        yield* put("/alias/test/plain", "plain-secret", "String");
        const error = yield* Effect.flip(Parameters.secureString("/alias/test/plain"));
        expect(error).toEqual(
          new Parameters.ParameterUnavailable({
            name: "/alias/test/plain",
            reason: "not a SecureString with a value",
          }),
        );
        expect(JSON.stringify(error)).not.toContain("plain-secret");
      }),
    );
  });
});
