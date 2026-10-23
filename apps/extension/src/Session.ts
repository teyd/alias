import { AliasClient, CodeLogin } from "@alias/sdk";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Browser from "./Browser.ts";
import { Status } from "./Messages.ts";

/**
 * The sign-in (PLAN.md §20.35): OAuth 2.1 with PKCE through `identity.launchWebAuthFlow`
 * (`CodeLogin` in the SDK), for an access token bound to the HTTP API with only the alias
 * scopes. The client registers itself at each sign-in, since its redirect URI names this
 * installation (`https://<extension id>.chromiumapp.org/`), so it works on any server, a
 * self-hoster's too, with no configuration there.
 *
 * Where the tokens live:
 * - the refresh token (30 days, rotated by every refresh, revocable as a "connected app" in the
 *   web app's settings) in `storage.local`, so a browser restart doesn't sign the user out;
 * - the access token (one hour) in `storage.session`, which stays in memory and is gone when
 *   the browser closes.
 * Neither area is open to web pages, and no content script of ours runs in one to read them.
 * Only the background talks to the server, and it refreshes under one lock: two concurrent
 * refreshes with one token look like theft to the server, which then revokes the grant.
 */

const SCOPES = ["aliases:read", "aliases:write"] as const;
const CLIENT_NAME = "Alias browser extension";
/** Refresh this long before the access token expires, so no request carries a dying one. */
const EARLY = Duration.minutes(1);

const Login = Schema.Struct({
  server: Schema.String,
  clientId: Schema.String,
  username: Schema.String,
  refreshToken: Schema.String,
});
type Login = typeof Login.Type;

const Access = Schema.Struct({ token: Schema.String, expiresAt: Schema.Number });

const KEY = { login: "login", access: "access", server: "server" } as const;

/** Not signed in (any more): the grant is gone, or there never was one. */
class SignedOut extends Schema.TaggedError<SignedOut>()("SignedOut", {}) {}

const statusOf = (login: Option.Option<Login>, server: Option.Option<string>): Status =>
  Option.match(login, {
    onNone: () => Status.cases.SignedOut.make({ server }),
    onSome: (found) =>
      Status.cases.SignedIn.make({
        server: found.server,
        username: found.username,
      }),
  });

const make = Effect.fn("Session.make")(function* (defaultServer: Option.Option<string>) {
  const context = yield* Effect.context<
    | Effect.Services<ReturnType<typeof CodeLogin.start>>
    | Effect.Services<ReturnType<typeof CodeLogin.refresh>>
  >();
  const lock = yield* Semaphore.make(1);

  const login = Browser.read("local", KEY.login, Login);
  const lastServer = Effect.map(Browser.read("local", KEY.server, Schema.String), (server) =>
    Option.orElse(server, () => defaultServer),
  );
  const forget = Effect.all(
    [Browser.remove("local", KEY.login), Browser.remove("session", KEY.access)],
    { concurrency: "unbounded", discard: true },
  );

  const store = (current: Login, tokens: CodeLogin.Tokens) =>
    Effect.all(
      [
        Browser.write("local", KEY.login, Login, {
          ...current,
          refreshToken: Redacted.value(tokens.refreshToken),
        }),
        Browser.write("session", KEY.access, Access, {
          token: Redacted.value(tokens.accessToken),
          expiresAt: DateTime.toEpochMillis(tokens.expiresAt),
        }),
      ],
      { concurrency: "unbounded", discard: true },
    );

  const status = Effect.map(
    Effect.all([login, lastServer], { concurrency: "unbounded" }),
    ([found, server]) => statusOf(found, server),
  );

  /** Revokes the grant (RFC 7009) if the server is reachable, and forgets it either way. */
  const signOutQuietly = Effect.fn("Session.signOutQuietly")(function* () {
    const found = yield* login;
    if (Option.isSome(found)) {
      yield* CodeLogin.logout({
        baseUrl: found.value.server,
        clientId: found.value.clientId,
        refreshToken: Redacted.make(found.value.refreshToken),
      }).pipe(
        Effect.catchTags({
          HttpClientError: (error) => Effect.logWarning("sign-out not confirmed", error),
          SchemaError: (error) => Effect.logWarning("sign-out not confirmed", error),
        }),
      );
    }
    yield* forget;
  }, Effect.provide(context));

  const signIn = Effect.fn("Session.signIn")(function* (server: string) {
    const redirectUri = Browser.redirectUri();
    const clientId = yield* CodeLogin.register({
      baseUrl: server,
      redirectUri,
      clientName: CLIENT_NAME,
    });
    const pending = yield* CodeLogin.start({
      baseUrl: server,
      clientId,
      redirectUri,
      scopes: SCOPES,
    });
    const redirected = yield* Browser.launchWebAuthFlow(pending.authorizationUrl);
    const tokens = yield* CodeLogin.finish(pending, redirected);
    const client = yield* AliasClient.make({ baseUrl: server, token: tokens.accessToken });
    const me = yield* client.account.me();
    // A sign-in replaces the one before; that one's grant goes.
    yield* signOutQuietly();
    const current: Login = {
      server,
      clientId,
      username: me.username,
      refreshToken: Redacted.value(tokens.refreshToken),
    };
    yield* store(current, tokens);
    yield* Browser.write("local", KEY.server, Schema.String, server);
    return statusOf(Option.some(current), Option.some(server));
  }, Effect.provide(context));

  const signOut = Effect.andThen(signOutQuietly(), status);

  /** A client for the signed-in user, with a live access token. */
  const client = Effect.fn("Session.client")(
    function* () {
      const current = yield* login;
      if (Option.isNone(current)) return yield* new SignedOut();
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const access = yield* Browser.read("session", KEY.access, Access);
      const token = yield* Option.match(
        Option.filter(access, (live) => live.expiresAt - Duration.toMillis(EARLY) > now),
        {
          onSome: (live) => Effect.succeed(Redacted.make(live.token)),
          onNone: () =>
            CodeLogin.refresh({
              baseUrl: current.value.server,
              clientId: current.value.clientId,
              refreshToken: Redacted.make(current.value.refreshToken),
            }).pipe(
              Effect.tap((tokens) => store(current.value, tokens)),
              Effect.map((tokens) => tokens.accessToken),
              // The grant is gone: revoked, disconnected in the web app, or lapsed.
              Effect.catchTag("OAuthError", () => Effect.andThen(forget, new SignedOut())),
            ),
        },
      );
      return yield* AliasClient.make({ baseUrl: current.value.server, token });
    },
    lock.withPermits(1),
    Effect.provide(context),
  );

  return { status, signIn, signOut, client };
});

export class Session extends Context.Service<Session, Effect.Success<ReturnType<typeof make>>>()(
  "@alias/extension/Session",
) {}

/** The service. `defaultServer` is the build's server, offered until the user signs in. */
export const layer = (defaultServer: Option.Option<string>) =>
  Layer.effect(Session, make(defaultServer));
