import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Answer, Request } from "../Messages.ts";

/**
 * The popup's edge: what it asks the background (`background.ts`) and the browser, as promises
 * for TanStack Query.
 */

/** What the popup shows for a failure. */
export class PopupError extends Schema.TaggedError<PopupError>()("PopupError", {
  message: Schema.String,
}) {}

const noAnswer = () => new PopupError({ message: "The extension didn't answer. Try again." });

/**
 * Encodes `request`, asks the background and decodes its answer as `expected`; a `Failed` answer rejects with its
 * message, and so does a missing or malformed one (the background restarted mid-request).
 */
export const ask = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
  request: Request,
  expected: S,
): Promise<S["Type"]> =>
  Effect.runPromise(
    Schema.encodeEffect(Request)(request).pipe(
      Effect.mapError(noAnswer),
      Effect.flatMap((encoded) =>
        Effect.tryPromise({ try: () => chrome.runtime.sendMessage(encoded), catch: noAnswer }),
      ),
      Effect.flatMap((answer) =>
        Answer.guards.Failed(answer)
          ? Effect.fail(new PopupError({ message: answer.message }))
          : Schema.decodeUnknownEffect(expected)(answer).pipe(Effect.mapError(noAnswer)),
      ),
    ),
  );

/** The tab the popup was opened over, with its address (readable thanks to `activeTab`). */
export const activeTab = (): Promise<
  Option.Option<{ readonly id: number; readonly url: string }>
> =>
  Effect.runPromise(
    Effect.tryPromise(() => chrome.tabs.query({ active: true, lastFocusedWindow: true })).pipe(
      Effect.map((tabs) =>
        Option.flatMap(Arr.head(tabs), (tab) =>
          Option.map(Option.fromNullishOr(tab.id), (id) => ({ id, url: tab.url ?? "" })),
        ),
      ),
      Effect.orElseSucceed(() => Option.none()),
    ),
  );

/**
 * Asks for the host permission of a server the build doesn't know, while the click that asked
 * for it still counts as the user's gesture.
 */
export const allowServer = (pattern: string): Promise<boolean> =>
  Effect.runPromise(
    Effect.tryPromise(async () =>
      (await chrome.permissions.contains({ origins: [pattern] }))
        ? true
        : chrome.permissions.request({ origins: [pattern] }),
    ).pipe(Effect.orElseSucceed(() => false)),
  );
