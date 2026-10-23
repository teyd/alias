import { BrowserCrypto } from "@effect/platform-browser";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as Aliases from "./Aliases.ts";
import * as Browser from "./Browser.ts";
import * as Fill from "./Fill.ts";
import { type AliasKind, Answer, Request, Response } from "./Messages.ts";
import * as Session from "./Session.ts";

/**
 * The background (a service worker in Chromium, an event page in Firefox): the only part that
 * holds tokens and talks to the server (PLAN.md §20.35). The popup asks it through
 * `runtime.sendMessage`; the context menu on editable fields calls it directly.
 */

/** The build's server (`ALIAS_EXTENSION_SERVER`), offered until the user names another. */
const DEFAULT_SERVER = Option.filter(
  Option.fromNullishOr(import.meta.env.VITE_ALIAS_SERVER),
  (server) => server !== "",
);

/**
 * Requests carry the token and nothing else: no cookies. A session cookie of the web app would
 * make the API take the request for the web app's own and refuse it as cross-site, and the
 * extension must act with exactly the scopes it was granted.
 */
const HttpLive = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: "omit" })),
);

const runtime = ManagedRuntime.make(
  Session.layer(DEFAULT_SERVER).pipe(
    Layer.provideMerge(Layer.merge(HttpLive, BrowserCrypto.layer)),
  ),
);

const failed = (message: string) => Effect.succeed(Answer.cases.Failed.make({ message }));
const unreachable = () => failed("The server didn't answer as expected. Try again later.");

const createAndFill = Effect.fn("background.createAndFill")(function* (
  kind: AliasKind,
  tabId: number,
  frameId: Option.Option<number>,
  subdomain: Option.Option<string>,
) {
  const session = yield* Session.Session;
  const client = yield* session.client();
  const created = yield* Aliases.create(client, kind, yield* Browser.tabUrl(tabId), subdomain);
  const isFilled = yield* Fill.fill(tabId, frameId, created.address).pipe(
    Effect.catchTag("BrowserFailed", () => Effect.succeed(false)),
  );
  return Answer.cases.Created.make({ ...created, isFilled });
});

const answer = Effect.fn("background.answer")(function* (request: Request) {
  const session = yield* Session.Session;
  const answered = Match.valueTags(request, {
    GetStatus: () => session.status,
    SignIn: ({ server }) => session.signIn(server),
    SignOut: () => session.signOut,
    CreateAlias: ({ kind, tabId, subdomain }) =>
      createAndFill(kind, tabId, Option.none(), subdomain),
    ListRecent: () =>
      session.client().pipe(
        Effect.flatMap(Aliases.recent),
        Effect.map((aliases) => Answer.cases.Recent.make({ aliases })),
      ),
    ListSubdomains: () =>
      session.client().pipe(
        Effect.flatMap(Aliases.subdomains),
        Effect.map((subdomains) => Answer.cases.Subdomains.make({ subdomains })),
      ),
    Fill: ({ tabId, address }) =>
      Effect.map(Fill.fill(tabId, Option.none(), address), (isFilled) =>
        Answer.cases.Filled.make({ isFilled }),
      ),
  });
  return yield* answered.pipe(
    // Every failure, worded for the person.
    Effect.catchTags({
      CannotCreate: (error) => failed(error.message),
      BrowserFailed: (error) => failed(`The browser refused: ${error.message}`),
      SignedOut: () => failed("Sign in first."),
      CodeLoginFailed: () => failed("The sign-in didn't complete. Try again."),
      OAuthError: () => failed("The server refused the sign-in. Try again."),
      TooManyAttempts: () => failed("Too many attempts. Wait a while and try again."),
      Forbidden: () => failed("The sign-in doesn't allow that. Sign out and in again."),
      Unauthenticated: () => failed("The sign-in has ended. Sign out and in again."),
      CrossSiteRequest: unreachable,
      AliasNotFound: () => failed("That alias is gone. Try again."),
      HttpClientError: unreachable,
      SchemaError: unreachable,
    }),
  );
});

/** Only the extension's own popup may ask; anything else, or any other shape, is ignored. */
const isOwnPopup = (sender: chrome.runtime.MessageSender) =>
  sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html");

const encodeResponse = Schema.encodeEffect(Response);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isOwnPopup(sender)) return false;
  const request = Schema.decodeUnknownOption(Request)(message);
  if (Option.isNone(request)) return false;
  void runtime
    .runPromise(
      answer(request.value).pipe(
        // A bug must still answer, or the popup waits forever.
        Effect.catchDefect((defect) =>
          Effect.andThen(Effect.logError("unexpected failure", defect), unreachable()),
        ),
        Effect.flatMap(encodeResponse),
      ),
    )
    .then(sendResponse);
  // The answer comes later.
  return true;
});

const MENU = { parent: "alias", random: "fill-random", site: "fill-site" } as const;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU.parent, title: "Alias", contexts: ["editable"] });
  chrome.contextMenus.create({
    id: MENU.site,
    parentId: MENU.parent,
    title: "Fill an alias for this site",
    contexts: ["editable"],
  });
  chrome.contextMenus.create({
    id: MENU.random,
    parentId: MENU.parent,
    title: "Fill a new random alias",
    contexts: ["editable"],
  });
});

const MenuItem = Schema.Literals([MENU.random, MENU.site]);

/**
 * The click grants `activeTab` for this tab, which is what lets the background read its address
 * and fill the field that was right-clicked, in the frame it is in. When that fails (signed out,
 * say), the popup opens to say why, where the browser allows it.
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const item = Schema.decodeUnknownOption(MenuItem)(info.menuItemId);
  const tabId = Option.fromNullishOr(tab?.id);
  if (Option.isNone(item) || Option.isNone(tabId)) return;
  const kind = item.value === MENU.site ? "site" : "random";
  void runtime.runPromise(
    // The context menu has no picker: site aliases go on the primary username's subdomain.
    createAndFill(kind, tabId.value, Option.fromNullishOr(info.frameId), Option.none()).pipe(
      Effect.asVoid,
      Effect.catchCause(() =>
        Effect.tryPromise(() => chrome.action.openPopup()).pipe(Effect.ignore),
      ),
    ),
  );
});
