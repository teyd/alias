/**
 * The API for `pnpm dev`. It runs the real Lambda handler behind the function URL emulator, on
 * the persistent fakecloud that `scripts/dev.ts` starts, and seeds one demo alias. Passkeys are
 * bound to `localhost` and the Vite dev server's origin, which proxies `/v1` here. Confirmation
 * mail goes through SES on the same fakecloud, as `ALIAS_CONFIRMATION_FROM` (default
 * `no-reply@<first shared domain>`, which `apps/inbound/bin/dev.ts` verifies as an identity).
 *
 * The demo alias belongs to a demo user with one verified forwarding address, so mail sent to it
 * over SMTP comes out forwarded in fakecloud's sent mail.
 */
import { AwsClient, Transport } from "@alias/aws";
import { SharedDomains } from "@alias/core";
import { AliasRepo, Dynamo, RecipientRepo, Table } from "@alias/db";
import { FunctionUrlServer } from "@alias/lambda-emulator";
import { NodeCrypto, NodeRuntime } from "@effect/platform-node";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { MailSettings, makeFunctionUrlHandler, RelyingParty } from "../src/index.ts";

const port = Number(process.env.ALIAS_API_PORT ?? 8787);
const fakecloudUrl = `http://127.0.0.1:${process.env.ALIAS_FAKECLOUD_PORT ?? 4566}`;
const database = Dynamo.emulator(fakecloudUrl, "alias");
const sharedDomains = SharedDomains.layer(process.env.ALIAS_SHARED_DOMAINS ?? "alias.test");
const mail = Layer.merge(
  Transport.ses.pipe(Layer.provide(AwsClient.emulator(fakecloudUrl))),
  MailSettings.layer(Option.fromUndefinedOr(process.env.ALIAS_CONFIRMATION_FROM)),
).pipe(Layer.provideMerge(sharedDomains));
const relyingParty = RelyingParty.layer({
  id: "localhost",
  origin: `http://localhost:${process.env.ALIAS_WEB_PORT ?? 5173}`,
});
/** Where the demo alias forwards to. Read it in fakecloud's sent mail; nothing leaves the machine. */
const demoRecipient = process.env.ALIAS_DEV_RECIPIENT ?? "demo@mailbox.test";

const seed = Effect.fn("api.dev.seed")(function* () {
  yield* Table.ensure();
  const repo = yield* AliasRepo.make();
  yield* repo
    .insert({
      id: "al_demo",
      userId: "usr_demo",
      domain: "alias.test",
      localPart: "shop",
      mode: "forward",
      createdAt: 0,
    })
    .pipe(Effect.catchTag("AliasTaken", () => Effect.void));
  // A verified forwarding address, created the way the API does: pending, then confirmed.
  const recipients = yield* RecipientRepo.RecipientRepo;
  const now = yield* DateTime.now;
  const recipient = { id: "rcp_demo", userId: "usr_demo", address: demoRecipient, createdAt: now };
  const added = yield* recipients
    .add(
      recipient,
      { tokenHash: "dev", expiresAt: DateTime.add(now, { hours: 1 }), sentAt: now },
      1,
    )
    .pipe(
      Effect.as(true),
      Effect.catchTag("RecipientExists", () => Effect.succeed(false)),
    );
  if (added) {
    yield* recipients.confirm(
      { ...recipient, verifiedAt: Option.none(), lastSentAt: now, isDefault: false },
      "dev",
      now,
    );
  }
});

const serve = Effect.fn("api.dev")(function* () {
  yield* seed().pipe(
    Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
    Effect.provide(RecipientRepo.layer.pipe(Layer.provideMerge(database))),
  );
  const { handle } = makeFunctionUrlHandler(Layer.mergeAll(database, relyingParty, mail));
  const server = yield* FunctionUrlServer.make({
    port,
    handler: (event) => Effect.runPromise(handle(event)),
    functionName: "alias-api",
  });
  yield* Effect.logInfo(
    `api (function URL emulator) on ${server.url}, DynamoDB and SES at ${fakecloudUrl}`,
  );
  yield* Effect.never;
});

NodeRuntime.runMain(serve().pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)));
