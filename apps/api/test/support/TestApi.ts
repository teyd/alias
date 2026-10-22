import { AwsClient, Identities, Transport } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { SharedDomains, TempDomains } from "@alias/core";
import { freshTable } from "@alias/db/testing";
import { freshInbox } from "@alias/inbox/testing";
import { NodeCrypto } from "@effect/platform-node";
import { UrlPolicy } from "@alias/webhooks";
import { FunctionUrlServer } from "@alias/lambda-emulator";
import { freshQueue } from "@alias/webhooks/testing";
import { Doh } from "@alias/dns";
import { DohServer } from "@alias/doh-emulator";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { MailSettings, RelyingParty, makeFunctionUrlHandler } from "../../src/index.ts";
import * as Browser from "./Browser.ts";
import * as TestAuthenticator from "./TestAuthenticator.ts";

const fakecloudClient = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), ({ url }) => AwsClient.emulator(url)),
);

/** The dev setup's shared domain, verified as an SES identity before the API sends from it. */
const sharedDomain = "alias.test";

/** The production DoH client, pointed at the emulator. */
const resolver = Layer.unwrap(
  Effect.map(Effect.service(DohServer.DohServer), (server) => Doh.layer(server.url)),
);

/**
 * The API Lambda in its own fakecloud: a fresh table for DynamoDB, SES sending (verified for the
 * shared domain) and identities, and its own DoH emulator. `context` reaches the same fakecloud
 * and DoH emulator, e.g. for `FakeCloud.sentEmails` or `DohServer.setZone`. The handler reads the
 * test's clock, so `TestClock.adjust` moves time for it too.
 */
export const make = Effect.acquireRelease(
  Effect.gen(function* () {
    const table = freshTable();
    const context = yield* Layer.build(
      Layer.mergeAll(
        table,
        freshQueue(),
        freshInbox().pipe(Layer.provide(Layer.merge(table, NodeCrypto.layer))),
        Transport.ses.pipe(Layer.provide(fakecloudClient)),
        Identities.layer.pipe(Layer.provide(fakecloudClient)),
        resolver,
      ).pipe(Layer.provideMerge(Layer.merge(FakeCloud.layer(), DohServer.layer()))),
    );
    yield* Transport.ensureIdentity(sharedDomain).pipe(
      Effect.provide(fakecloudClient),
      Effect.provide(context),
    );
    const clock = yield* Clock.Clock;
    const handler = makeFunctionUrlHandler(
      Layer.mergeAll(
        Layer.succeedContext(context),
        Layer.succeed(Clock.Clock, clock),
        RelyingParty.layer({ id: sharedDomain, origin: Browser.origin }),
        // Receivers in tests listen on loopback over http.
        UrlPolicy.layer({ isLoopbackAllowed: true }),
        // A second shared domain lets alias tests pick between domains.
        MailSettings.layer(Option.some(`no-reply@${sharedDomain}`)).pipe(
          Layer.provideMerge(SharedDomains.layer(`${sharedDomain},alias2.test`)),
        ),
        TempDomains.layer("tmp.test,tmp2.test").pipe(
          Layer.provide(SharedDomains.layer(`${sharedDomain},alias2.test`)),
        ),
      ),
    );
    return {
      ...handler,
      context,
      browser: () => Browser.make(handler.handle),
      /** A client sending `Authorization: Bearer <token>` and no cookies, from `sourceIp`. */
      withToken: (token: string, sourceIp = "198.51.100.7") =>
        Browser.make(handler.handle, { headers: { authorization: `Bearer ${token}` }, sourceIp }),
    };
  }),
  (handler) => Effect.promise(() => handler.dispose()),
);

export const RegistrationChallenge = Schema.Struct({
  challengeId: Schema.String,
  options: Schema.Struct({
    challenge: Schema.String,
    rp: Schema.Struct({ id: Schema.optionalKey(Schema.String) }),
    user: Schema.Struct({ id: Schema.String }),
  }),
});
export type RegistrationChallenge = typeof RegistrationChallenge.Type;

/** Registers `username` with a new passkey; the browser keeps the session cookie. */
export const signUp = Effect.fn("signUp")(function* (
  browser: Browser.Client,
  authenticator: TestAuthenticator.TestAuthenticator,
  username: string,
) {
  const started = yield* browser.post("/v1/auth/register/options", { username });
  const { challengeId, options } = Schema.decodeUnknownSync(RegistrationChallenge)(started.body);
  return yield* browser.post("/v1/auth/register", {
    challengeId,
    credential: authenticator.create(options),
  });
});

export const AuthenticationChallenge = Schema.Struct({
  challengeId: Schema.String,
  options: Schema.Struct({ challenge: Schema.String, rpId: Schema.optionalKey(Schema.String) }),
});
export type AuthenticationChallenge = typeof AuthenticationChallenge.Type;

/** Logs in with the authenticator's newest passkey; the browser keeps the session cookie. */
export const logIn = Effect.fn("logIn")(function* (
  browser: Browser.Client,
  authenticator: TestAuthenticator.TestAuthenticator,
) {
  const started = yield* browser.post("/v1/auth/login/options");
  const { challengeId, options } = Schema.decodeUnknownSync(AuthenticationChallenge)(started.body);
  return yield* browser.post("/v1/auth/login", {
    challengeId,
    credential: authenticator.get(options),
  });
});

const Me = Schema.Struct({ userId: Schema.String, username: Schema.String });

/** A browser signed in as a freshly registered user. */
export const signedIn = Effect.fn("signedIn")(function* (
  open: () => Browser.Client,
  username: string,
) {
  const browser = open();
  const registered = yield* signUp(browser, TestAuthenticator.make(Browser.origin), username);
  return { browser, ...Schema.decodeUnknownSync(Me)(registered.body) };
});

/**
 * {@link make}'s API behind the function URL emulator on port 0, for clients that speak HTTP
 * (the SDK, the CLI). `url` is its origin; `browser` and `withToken` still reach the same table.
 */
export const served = Effect.flatMap(make, (api) =>
  FunctionUrlServer.make({ handler: (event) => Effect.runPromise(api.handle(event)) }).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.map((server) => ({ ...api, url: server.url })),
  ),
);
