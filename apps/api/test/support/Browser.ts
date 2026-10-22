import { FunctionUrl } from "@alias/aws";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import type * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type * as Types from "effect/Types";

export const origin = "https://alias.test";

type Handle = (
  event: FunctionUrl.FunctionUrlEvent,
) => Effect.Effect<FunctionUrl.FunctionUrlResult, unknown>;

interface Response {
  readonly status: number;
  /** The parsed JSON body; `null` when the response had none (204). */
  readonly body: Schema.Json;
  readonly setCookies: ReadonlyArray<string>;
  readonly headers: Readonly<Record<string, string>>;
}

export type Client = ReturnType<typeof make>;

/** How a client other than the browser calls: its own headers and network address. */
interface Options {
  readonly headers?: Readonly<Record<string, string>>;
  readonly sourceIp?: string;
}

/**
 * Calls a function URL handler the way a browser on {@link origin} would: payload-2.0 events
 * with JSON bodies, and a cookie jar that honours `Set-Cookie` (including `Max-Age=0`). With
 * `options`, it adds headers (`authorization`, say) and calls from another address.
 */
export const make = (handle: Handle, options: Options = {}) => {
  let jar = HashMap.empty<string, string>();

  const remember = (setCookie: string) => {
    const [pair = "", ...attributes] = setCookie.split(";");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const isExpired = Arr.some(attributes, (attribute) =>
      Str.startsWith("max-age=0")(attribute.trim().toLowerCase()),
    );
    jar =
      isExpired || Str.isEmpty(value) ? HashMap.remove(jar, name) : HashMap.set(jar, name, value);
  };

  const request = Effect.fn("Browser.request")(function* (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body: Option.Option<Schema.Json>,
    form?: Readonly<Record<string, string>>,
  ) {
    const accepts = {
      accept: "application/json",
      host: "api.alias.test",
      origin,
      ...options.headers,
    };
    const headers = P.isNotUndefined(form)
      ? { ...accepts, "content-type": "application/x-www-form-urlencoded" }
      : Option.match(body, {
          onNone: () => accepts,
          onSome: () => ({ ...accepts, "content-type": "application/json" }),
        });
    const [rawPath = path, rawQueryString = ""] = path.split("?");
    const event: Types.Mutable<FunctionUrl.FunctionUrlEvent> = {
      version: "2.0",
      rawPath,
      rawQueryString,
      headers,
      isBase64Encoded: false,
      requestContext: {
        domainName: "api.alias.test",
        requestId: "req-1",
        timeEpoch: 0,
        http: { method, path: rawPath, sourceIp: options.sourceIp ?? "127.0.0.1" },
      },
    };
    const cookies = Arr.map(Arr.fromIterable(jar), ([name, value]) => `${name}=${value}`);
    if (Arr.isArrayNonEmpty(cookies)) event.cookies = cookies;
    if (Option.isSome(body)) event.body = JSON.stringify(body.value);
    if (P.isNotUndefined(form)) event.body = new URLSearchParams(form).toString();

    const result = yield* FunctionUrl.decode(event).pipe(Effect.flatMap(handle));
    const setCookies = result.cookies ?? [];
    Arr.map(setCookies, remember);
    const text = result.body ?? "";
    const response: Response = {
      status: result.statusCode,
      body: Str.isEmpty(text) ? null : JSON.parse(text),
      setCookies,
      headers: result.headers ?? {},
    };
    return response;
  });

  return {
    get: (path: string) => request("GET", path, Option.none()),
    post: (path: string, body: Schema.Json = {}) => request("POST", path, Option.some(body)),
    /** An OAuth-style `application/x-www-form-urlencoded` POST. */
    postForm: (path: string, fields: Readonly<Record<string, string>>) =>
      request("POST", path, Option.none(), fields),
    put: (path: string, body: Schema.Json) => request("PUT", path, Option.some(body)),
    patch: (path: string, body: Schema.Json) => request("PATCH", path, Option.some(body)),
    delete: (path: string) => request("DELETE", path, Option.none()),
    cookie: (name: string) => HashMap.get(jar, name),
    /** Sets a cookie by hand, e.g. to replay a logged-out session. */
    setCookie: (name: string, value: string) => {
      jar = HashMap.set(jar, name, value);
    },
  };
};
