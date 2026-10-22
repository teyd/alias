/**
 * The API for `pnpm dev`. It runs the real Lambda handler behind the function URL emulator, on
 * the persistent fakecloud that `scripts/dev.ts` starts, and seeds one demo alias. Passkeys are
 * bound to `localhost` and the Vite dev server's origin, which proxies `/v1` here. Confirmation
 * mail goes through SES on the same fakecloud, as `ALIAS_CONFIRMATION_FROM` (default
 * `no-reply@<first shared domain>`, which `apps/inbound/bin/dev.ts` verifies as an identity).
 *
 * The demo alias belongs to a demo user with one verified forwarding address, so mail sent to it
 * over SMTP comes out forwarded in fakecloud's sent mail.
 *
 * Dev-only hook: when someone signs up, their subdomain of each shared domain is verified as its
 * own SES identity on fakecloud (see `verifySubdomains`).
 *
 * Custom domains: SES identities live on the same fakecloud, DNS checks go to the DoH emulator
 * (`tools/doh-emulator/bin/serve.ts`, on `ALIAS_DOH_PORT`), and the verification cron runs here
 * every minute instead of on EventBridge Scheduler.
 */
import { AwsClient, type FunctionUrl, Identities, Transport } from "@alias/aws";
import { SharedDomains, TempDomains } from "@alias/core";
import { AliasRepo, DomainRepo, Dynamo, RecipientRepo, Table } from "@alias/db";
import { Doh } from "@alias/dns";
import { Inbox } from "@alias/inbox";
import { FunctionUrlServer } from "@alias/lambda-emulator";
import { UrlPolicy, WebhookQueue } from "@alias/webhooks";
import { NodeCrypto, NodeRuntime } from "@effect/platform-node";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as DomainVerification from "../src/DomainVerification.ts";
import { MailSettings, makeFunctionUrlHandler, RelyingParty } from "../src/index.ts";

const port = Number(process.env.ALIAS_API_PORT ?? 8787);
const fakecloudUrl = `http://127.0.0.1:${process.env.ALIAS_FAKECLOUD_PORT ?? 4566}`;
const database = Dynamo.emulator(fakecloudUrl, "alias");
const sharedDomains = SharedDomains.layer(process.env.ALIAS_SHARED_DOMAINS ?? "alias.test");
// The configuration set `apps/inbound/bin/dev.ts` creates, so bounces reach the feedback handler.
const mail = Layer.merge(
  Transport.layer({ configurationSet: Option.some("alias-events") }).pipe(
    Layer.provide(AwsClient.emulator(fakecloudUrl)),
  ),
  MailSettings.layer(Option.fromUndefinedOr(process.env.ALIAS_CONFIRMATION_FROM)),
).pipe(Layer.provideMerge(sharedDomains));
/**
 * The webhook queue, as `apps/webhooks/bin/dev.ts` delivers from it; created here too, so either
 * may start first. Dev receivers may listen on `http://localhost`.
 */
const webhooks = Layer.merge(
  WebhookQueue.dev.pipe(Layer.provide(AwsClient.emulator(fakecloudUrl))),
  UrlPolicy.layer({ isLoopbackAllowed: true }),
);
const domains = Layer.merge(
  Identities.layer.pipe(Layer.provide(AwsClient.emulator(fakecloudUrl))),
  Doh.layer(`http://127.0.0.1:${process.env.ALIAS_DOH_PORT ?? 8053}/dns-query`),
);
/** The inbox store `apps/inbound/bin/dev.ts` writes to, and the temp-mail domains (`tmp.test`). */
const inbox = Inbox.dev(fakecloudUrl, database);
const tempDomains = TempDomains.layer(process.env.ALIAS_TEMP_DOMAINS ?? "tmp.test").pipe(
  Layer.provide(sharedDomains),
);
const relyingParty = RelyingParty.layer({
  id: "localhost",
  origin: `http://localhost:${process.env.ALIAS_WEB_PORT ?? 5173}`,
});
/** Where the demo alias forwards to. Read it in fakecloud's sent mail; nothing leaves the machine. */
const demoRecipient = process.env.ALIAS_DEV_RECIPIENT ?? "demo@mailbox.test";

const Registered = Schema.fromJsonString(Schema.Struct({ username: Schema.String }));

/**
 * fakecloud doesn't let a verified domain cover its subdomains, while AWS does (PLAN.md §20.5).
 * Without this, mail to aliases on a new user's subdomain (`shop@ada.alias.test`) would be
 * forwarded by the pipeline and then refused by fakecloud's SES as an unverified sender. So,
 * in dev only, a successful sign-up verifies `<username>.<shared domain>` for every shared
 * domain. Production needs nothing of the kind: the shared domain's identity covers them all.
 */
const verifySubdomains = Effect.fn("api.dev.verifySubdomains")(function* (
  event: FunctionUrl.FunctionUrlEvent,
  result: FunctionUrl.FunctionUrlResult,
) {
  if (event.rawPath !== "/v1/auth/register" || result.statusCode !== 200) return;
  const { username } = yield* Schema.decodeUnknownEffect(Registered)(result.body ?? "");
  const domains = yield* SharedDomains.SharedDomains;
  yield* Effect.forEach(domains, (domain) => Transport.ensureIdentity(`${username}.${domain}`), {
    concurrency: 1,
    discard: true,
  });
  yield* Effect.logInfo(`dev: verified ${username}'s subdomains as SES identities`);
});

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
      {
        ...recipient,
        verifiedAt: Option.none(),
        lastSentAt: now,
        isDefault: false,
        bouncedAt: Option.none(),
        complainedAt: Option.none(),
        encryption: Option.none(),
      },
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
  const { handle } = makeFunctionUrlHandler(
    Layer.mergeAll(database, relyingParty, mail, webhooks, domains, inbox, tempDomains),
  );
  // The verification cron, as EventBridge Scheduler would run it (every ten minutes in infra).
  yield* DomainVerification.runDue().pipe(
    Effect.tap((outcome) =>
      outcome.checked + outcome.failed > 0
        ? Effect.logInfo("domains checked", outcome)
        : Effect.void,
    ),
    Effect.catch((error) => Effect.logError("domain cron failed", error)),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.provide(DomainRepo.layer.pipe(Layer.provideMerge(Layer.merge(database, domains)))),
    Effect.forkScoped,
  );
  const devHooks = Layer.merge(sharedDomains, AwsClient.emulator(fakecloudUrl));
  const server = yield* FunctionUrlServer.make({
    port,
    handler: (event) =>
      Effect.runPromise(
        handle(event).pipe(
          Effect.tap((result) =>
            verifySubdomains(event, result).pipe(
              Effect.catch((error) => Effect.logError("dev: subdomain verification failed", error)),
            ),
          ),
          Effect.provide(devHooks),
        ),
      ),
    functionName: "alias-api",
  });
  yield* Effect.logInfo(
    `api (function URL emulator) on ${server.url}, DynamoDB and SES at ${fakecloudUrl}`,
  );
  yield* Effect.never;
});

NodeRuntime.runMain(serve().pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)));
