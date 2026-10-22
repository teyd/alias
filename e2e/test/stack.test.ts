import { RelyingParty, SharedDomains, makeFunctionUrlHandler } from "@alias/api";
import { TestAuthenticator } from "@alias/api/testing";
import { AliasRepo, type Dynamo } from "@alias/db";
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
const origin = "https://alias.test";

/** The real API Lambda behind the function URL emulator. Tests seed aliases through `AliasRepo`. */
const api = Layer.merge(
  Layer.unwrap(
    Effect.gen(function* () {
      const context = yield* Effect.context<Dynamo.Database>();
      const { handle, dispose } = makeFunctionUrlHandler(
        Layer.mergeAll(
          Layer.succeedContext(context),
          RelyingParty.layer({ id: "alias.test", origin }),
          SharedDomains.layer("alias.test"),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      return FunctionUrlServer.layer({ handler: (event) => Effect.runPromise(handle(event)) });
    }),
  ),
  AliasRepo.layer,
).pipe(Layer.provide(database));

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

/** A browser-ish HTTP call: JSON in and out, the session cookie passed by hand. */
const call = (path: string, init: { readonly body?: Schema.Json; readonly cookie?: string } = {}) =>
  Effect.gen(function* () {
    const { url } = yield* FunctionUrlServer.FunctionUrlServer;
    const headers = new Headers({ "content-type": "application/json", origin });
    if (init.cookie !== undefined) headers.set("cookie", init.cookie);
    const request: RequestInit = { method: init.body === undefined ? "GET" : "POST", headers };
    if (init.body !== undefined) request.body = JSON.stringify(init.body);
    const response = yield* Effect.promise(() => fetch(`${url}${path}`, request));
    const text = yield* Effect.promise(() => response.text());
    return {
      status: response.status,
      body: text === "" ? null : JSON.parse(text),
      cookies: response.headers.getSetCookie(),
    };
  });

/** Signs up with a fresh software passkey and returns the session cookie and user ID. */
const signUp = (username: string) =>
  Effect.gen(function* () {
    const authenticator = TestAuthenticator.make(origin);
    const started = yield* call("/v1/auth/register/options", { body: { username } });
    const registered = yield* call("/v1/auth/register", {
      body: {
        challengeId: started.body.challengeId,
        credential: authenticator.create(started.body.options),
      },
    });
    expect(registered.status).toBe(200);
    const cookie = (registered.cookies[0] ?? "").split(";")[0] ?? "";
    return { cookie, userId: String(registered.body.userId) };
  });

describe("emulated stack", () => {
  it.layer(stack, { timeout: 30_000 })((it) => {
    it.effect("serves the API over a function URL", () =>
      Effect.gen(function* () {
        expect(yield* call("/health")).toMatchObject({ status: 200, body: { status: "ok" } });
      }),
    );

    it.effect("signs up with a passkey, receives mail for an alias and resolves it", () =>
      Effect.gen(function* () {
        const { cookie, userId } = yield* signUp("shopper");
        expect(yield* call("/v1/me", { cookie })).toMatchObject({
          status: 200,
          body: { userId, username: "shopper" },
        });
        const aliases = yield* AliasRepo.AliasRepo;
        yield* aliases.insert({
          id: "al_shop",
          userId,
          domain: "user1.alias.test",
          localPart: "shop",
          mode: "forward",
          createdAt: 0,
        });

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

        expect(yield* call(`/v1/aliases/${domain}/${local}`)).toMatchObject({ status: 401 });
        expect(yield* call(`/v1/aliases/${domain}/${local}`, { cookie })).toMatchObject({
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
        const { cookie } = yield* signUp("visitor");
        const { status, body } = yield* call("/v1/aliases/alias.test/nobody", { cookie });
        expect(status).toBe(404);
        expect(body).toMatchObject({ _tag: "AliasNotFound" });
      }),
    );
  });
});
