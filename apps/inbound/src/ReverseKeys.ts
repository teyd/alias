import { ReverseToken } from "@alias/core";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Base64Url } from "effect/encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/** The keys that sign and check reverse-alias tokens (`ReverseToken` in `@alias/core`). */
export class ReverseKeys extends Context.Service<ReverseKeys, ReverseToken.Keyring>()(
  "@alias/inbound/ReverseKeys",
) {}

/** Says which entry is wrong, never what it holds. */
class InvalidReverseKeys extends Schema.TaggedError<InvalidReverseKeys>()("InvalidReverseKeys", {
  reason: Schema.String,
}) {}

const ENTRY = /^(\d{1,3}):([A-Za-z0-9_-]+)$/;

const key = Effect.fn("ReverseKeys.key")(function* (entry: string, index: number) {
  const fail = (what: string) =>
    Effect.fail(new InvalidReverseKeys({ reason: `entry ${index + 1}: ${what}` }));
  const match = ENTRY.exec(entry);
  if (match === null) return yield* fail("expected <version>:<base64url secret>");
  const secret = Base64Url.decode(match[2] ?? "");
  if (Result.isFailure(secret)) return yield* fail("secret is not base64url");
  const parsed: ReverseToken.Key = {
    version: Number(match[1]),
    secret: Redacted.make(secret.success),
  };
  return parsed;
});

/**
 * Parses `<version>:<base64url secret>` entries, comma-separated. The first entry mints new
 * tokens; the others only verify, so replies to older mail keep working through a rotation.
 * Secrets need at least 32 bytes (`openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`).
 */
export const parse = Effect.fn("ReverseKeys.parse")(function* (value: Redacted.Redacted<string>) {
  const entries = Arr.filter(
    Arr.map(Str.split(Redacted.value(value), ","), Str.trim),
    Str.isNonEmpty,
  );
  const keys = yield* Effect.forEach(entries, key, { concurrency: 1 });
  if (!Arr.isArrayNonEmpty(keys)) {
    return yield* new InvalidReverseKeys({ reason: "no key given" });
  }
  const [current, ...retired] = keys;
  return yield* ReverseToken.keyring({ current, retired }).pipe(
    Effect.mapError((error) => new InvalidReverseKeys({ reason: error.reason })),
  );
});

export const layer = (value: Redacted.Redacted<string>) => Layer.effect(ReverseKeys, parse(value));

/** `ALIAS_REVERSE_TOKEN_KEYS`. A bad value fails the cold start, and the message names no secret. */
export const config = Config.Redacted("ALIAS_REVERSE_TOKEN_KEYS").pipe(
  Config.mapEffect((value) =>
    parse(value).pipe(
      Effect.mapError(
        (error) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: `ALIAS_REVERSE_TOKEN_KEYS: ${error.reason}`,
            }),
          ),
      ),
    ),
  ),
);
