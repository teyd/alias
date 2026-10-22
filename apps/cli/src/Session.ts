import { AliasClient } from "@alias/sdk";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Credentials } from "./Credentials.ts";
import { NotLoggedIn } from "./Errors.ts";

/** Where the API is when nothing says otherwise. The service's domain isn't chosen yet (PLAN.md §10). */
export const DEFAULT_API_URL = "https://alias.example";

/** `ALIAS_TOKEN` (e.g. in CI) wins over the saved login; `ALIAS_API_URL` over its URL. */
const environment = Config.all({
  token: Config.option(Config.Redacted("ALIAS_TOKEN")),
  apiUrl: Config.option(Config.String("ALIAS_API_URL")),
});

/** The API URL to log in to: the flag, else `ALIAS_API_URL`, else the default. */
export const apiUrlFor = Effect.fn("Session.apiUrlFor")(function* (flag: Option.Option<string>) {
  const env = yield* environment;
  return Option.getOrElse(
    Option.orElse(flag, () => env.apiUrl),
    () => DEFAULT_API_URL,
  );
});

/** Whether the token comes from the environment, which `logout` can't forget. */
export const isFromEnvironment = Effect.map(environment, (env) => Option.isSome(env.token));

/** The typed API client for the current login. */
export const client = Effect.fn("Session.client")(function* () {
  const env = yield* environment;
  const stored = yield* (yield* Credentials).load;
  const token = Option.orElse(env.token, () =>
    Option.map(stored, (found) => Redacted.make(found.token)),
  );
  if (Option.isNone(token)) return yield* new NotLoggedIn();
  const baseUrl = Option.getOrElse(
    Option.orElse(env.apiUrl, () => Option.map(stored, (found) => found.apiUrl)),
    () => DEFAULT_API_URL,
  );
  return yield* AliasClient.make({ baseUrl, token: token.value });
});
