import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { callApi, runInBrowser } from "./api";

/**
 * Cloudflare Turnstile's widget API, the part the sign-up form uses (explicit rendering).
 * https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
 */
export interface TurnstileApi {
  readonly render: (
    container: HTMLElement,
    params: {
      readonly sitekey: string;
      readonly action: string;
      readonly theme: "light" | "dark" | "auto";
      readonly callback: (token: string) => void;
      readonly "expired-callback": () => void;
      /** Returning true tells the widget the page handled the error. */
      readonly "error-callback": (code: string) => boolean;
    },
  ) => string;
  readonly remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** Which widget to render, from the API (the emulator's in dev and tests). */
export const signupQuery = queryOptions({
  queryKey: ["auth", "signup"],
  queryFn: () => callApi((api) => api.auth.signup()),
  staleTime: Infinity,
});

class ScriptFailed extends Schema.TaggedError<ScriptFailed>()("ScriptFailed", {
  url: Schema.String,
}) {}

/**
 * Loads the widget script once; `window.turnstile` exists when it has run. Production's CSP must
 * allow `https://challenges.cloudflare.com` in `script-src` and `frame-src` (PLAN.md §20.27).
 */
const loadScript = (url: string) =>
  Effect.callback<TurnstileApi, ScriptFailed>((resume) => {
    const loaded = Option.fromUndefinedOr(window.turnstile);
    if (Option.isSome(loaded)) return resume(Effect.succeed(loaded.value));
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.addEventListener("load", () =>
      resume(
        Option.match(Option.fromUndefinedOr(window.turnstile), {
          onNone: () => Effect.fail(new ScriptFailed({ url })),
          onSome: Effect.succeed,
        }),
      ),
    );
    script.addEventListener("error", () => resume(Effect.fail(new ScriptFailed({ url }))));
    document.head.append(script);
  });

export const turnstileQuery = (scriptUrl: string) =>
  queryOptions({
    queryKey: ["turnstile", scriptUrl],
    queryFn: () => runInBrowser(loadScript(scriptUrl)),
    staleTime: Infinity,
    retry: false,
  });
