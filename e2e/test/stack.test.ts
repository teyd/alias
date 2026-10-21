import { makeFunctionUrlHandler } from "@alias/api";
import { AliasRepo } from "@alias/db";
import { freshTable } from "@alias/db/testing";
import { AwsClient, Inbound, SesEvent } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { FunctionUrlServer } from "@alias/lambda-emulator";
import { SesEmulator } from "@alias/ses-emulator";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { createTransport } from "nodemailer";

/**
 * The whole emulated stack, every listener on port 0:
 * SMTP → SES emulator (receipt rules, Lambda event) → S3 spool on fakecloud, and
 * HTTP → function URL emulator → the real API Lambda handler → DynamoDB on fakecloud.
 * One fakecloud process serves both S3 and DynamoDB, as one AWS account would.
 */
const aws = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), (fakecloud) => AwsClient.emulator(fakecloud.url)),
);
const spoolBucket = "alias-spool";
const spool = Layer.effectDiscard(Inbound.ensureSpool(spoolBucket)).pipe(Layer.provide(aws));
const database = freshTable();

const api = Layer.unwrap(
  Effect.gen(function* () {
    const context = yield* Layer.build(database);
    const { handle, dispose } = makeFunctionUrlHandler(Layer.succeedContext(context));
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    yield* AliasRepo.make().pipe(
      Effect.flatMap((repo) =>
        repo.insert({
          id: "al_shop",
          userId: "usr_1",
          domain: "user1.alias.test",
          localPart: "shop",
          mode: "forward",
          createdAt: 0,
        }),
      ),
      Effect.provide(context),
    );
    return FunctionUrlServer.layer({ handler: (event) => Effect.runPromise(handle(event)) });
  }),
);

const ses = SesEmulator.layer({
  verifiedDomains: ["alias.test"],
  rules: [
    {
      name: "all-verified",
      enabled: true,
      recipients: [],
      s3: { bucket: spoolBucket, objectKeyPrefix: Inbound.spoolPrefix },
      lambda: {
        functionArn: "arn:aws:lambda:eu-west-1:000000000000:function:inbound",
        invocationType: "Event",
      },
      scanEnabled: true,
    },
  ],
}).pipe(Layer.provide([aws, spool]));

const stack = Layer.mergeAll(api, ses, aws).pipe(
  Layer.provide([NodeCrypto.layer, FakeCloud.layer()]),
);

const getJson = (path: string) =>
  Effect.gen(function* () {
    const { url } = yield* FunctionUrlServer.FunctionUrlServer;
    const response = yield* Effect.promise(() => fetch(`${url}${path}`));
    return { status: response.status, body: yield* Effect.promise(() => response.json()) };
  });

describe("emulated stack", () => {
  it.layer(stack, { timeout: 30_000 })((it) => {
    it.effect("serves the API over a function URL", () =>
      Effect.gen(function* () {
        expect(yield* getJson("/health")).toEqual({ status: 200, body: { status: "ok" } });
      }),
    );

    it.effect("receives mail for an alias and resolves it through the API", () =>
      Effect.gen(function* () {
        const emulator = yield* SesEmulator.SesEmulator;
        yield* Effect.tryPromise(() =>
          createTransport({
            host: "127.0.0.1",
            port: emulator.smtpPort,
            secure: false,
            ignoreTLS: true,
          }).sendMail({
            from: "shop@store.example",
            to: "Shop@User1.alias.test",
            subject: "Order confirmed",
            text: "Thanks!",
          }),
        );

        const event = yield* Queue.take(emulator.events);
        const record = (yield* Schema.decodeUnknownEffect(SesEvent.SesEvent)(event)).Records[0];
        const recipient = record?.ses.receipt.recipients[0] ?? "";
        const [local, domain] = recipient.split("@");

        // Read the spool the way the inbound Lambda will: S3 GetObject by message ID.
        const raw = yield* Inbound.readMessage(spoolBucket, record?.ses.mail.messageId ?? "");
        expect(new TextDecoder().decode(raw)).toContain("Subject: Order confirmed");

        expect(yield* getJson(`/v1/aliases/${domain}/${local}`)).toEqual({
          status: 200,
          body: {
            id: "al_shop",
            address: "shop@user1.alias.test",
            mode: "forward",
            isActive: true,
          },
        });
      }),
    );

    it.effect("answers unknown aliases with the typed 404", () =>
      Effect.gen(function* () {
        const { status, body } = yield* getJson("/v1/aliases/alias.test/nobody");
        expect(status).toBe(404);
        expect(body).toMatchObject({ _tag: "AliasNotFound" });
      }),
    );
  });
});
