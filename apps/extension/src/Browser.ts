import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The WebExtension APIs the extension calls, as Effects. Chromium and Firefox both implement
 * them as promise-returning `chrome.*` in Manifest V3. Each failure becomes `BrowserFailed`.
 */

class BrowserFailed extends Schema.TaggedError<BrowserFailed>()("BrowserFailed", {
  operation: Schema.String,
  message: Schema.String,
}) {}

const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }));

const call = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new BrowserFailed({ operation, message: hasMessage(cause) ? cause.message : String(cause) }),
  });

/** One storage area's value under `key`, decoded; nothing when absent or not of that shape. */
export const read = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
  area: "local" | "session",
  key: string,
  schema: S,
) =>
  call(`storage.${area}.get`, () => chrome.storage[area].get(key)).pipe(
    Effect.map((items) => items[key]),
    Effect.flatMap((value) => Effect.option(Schema.decodeUnknownEffect(schema)(value))),
  );

/** Stores `value` under `key`, encoded with the schema `read` decodes it with. */
export const write = <S extends Schema.Constraint & { readonly EncodingServices: never }>(
  area: "local" | "session",
  key: string,
  schema: S,
  value: S["Type"],
) =>
  Schema.encodeEffect(schema)(value).pipe(
    Effect.orDie,
    Effect.flatMap((encoded) =>
      call(`storage.${area}.set`, () => chrome.storage[area].set({ [key]: encoded })),
    ),
  );

export const remove = (area: "local" | "session", key: string) =>
  call(`storage.${area}.remove`, () => chrome.storage[area].remove(key));

/** The OAuth redirect URI of this installation: `https://<extension id>.chromiumapp.org/`. */
export const redirectUri = () => chrome.identity.getRedirectURL();

/** Opens the sign-in window at `url`; answers the URL it was sent back to. */
export const launchWebAuthFlow = (url: string) =>
  call("identity.launchWebAuthFlow", () =>
    chrome.identity.launchWebAuthFlow({ url, interactive: true }),
  ).pipe(
    Effect.flatMap((redirected) =>
      redirected === undefined
        ? Effect.fail(
            new BrowserFailed({ operation: "identity.launchWebAuthFlow", message: "no answer" }),
          )
        : Effect.succeed(redirected),
    ),
  );

/** The tab's URL, readable once `activeTab` was granted for it. */
export const tabUrl = (tabId: number) =>
  call("tabs.get", () => chrome.tabs.get(tabId)).pipe(Effect.map((tab) => tab.url ?? ""));

/**
 * Runs `func(arg)` in one frame of the tab (the top one when `frameId` is none), in the extension's
 * isolated world, and answers its result.
 */
export const execute = <A>(
  tabId: number,
  frameId: Option.Option<number>,
  func: (arg: string) => A,
  arg: string,
) =>
  call("scripting.executeScript", () =>
    chrome.scripting.executeScript({
      target: Option.match(frameId, {
        onNone: () => ({ tabId }),
        onSome: (frame) => ({ tabId, frameIds: [frame] }),
      }),
      func,
      args: [arg],
    }),
  ).pipe(Effect.map((results) => results[0]?.result));
