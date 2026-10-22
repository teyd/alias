import { AwsClient, Transport } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { SharedDomains } from "@alias/core";
import { freshTable } from "@alias/db/testing";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { MailSettings, RelyingParty, makeFunctionUrlHandler } from "../../src/index.ts";
import * as Browser from "./Browser.ts";
import type * as TestAuthenticator from "./TestAuthenticator.ts";

const fakecloudClient = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), ({ url }) => AwsClient.emulator(url)),
);

/** The dev setup's shared domain, verified as an SES identity before the API sends from it. */
const sharedDomain = "alias.test";

/**
 * The API Lambda in its own fakecloud: a fresh table for DynamoDB, and SES sending, verified for
 * the shared domain. `context` reaches the same fakecloud, e.g. for `FakeCloud.sentEmails`. The
 * handler reads the test's clock, so `TestClock.adjust` moves time for it too.
 */
export const make = Effect.acquireRelease(
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.mergeAll(freshTable(), Transport.ses.pipe(Layer.provide(fakecloudClient))).pipe(
        Layer.provideMerge(FakeCloud.layer()),
      ),
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
        // A second shared domain lets alias tests pick between domains.
        MailSettings.layer(Option.some(`no-reply@${sharedDomain}`)).pipe(
          Layer.provideMerge(SharedDomains.layer(`${sharedDomain},alias2.test`)),
        ),
      ),
    );
    return { ...handler, context, browser: () => Browser.make(handler.handle) };
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
