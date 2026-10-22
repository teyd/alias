import { Base64Url } from "effect/encoding";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { constantTimeEqual } from "./internal/bytes.ts";
import * as Keyring from "./Keyring.ts";

/**
 * Proof that a request came through our CloudFront distribution (PLAN.md §20.26): CloudFront adds
 * an origin custom header holding the current key of a {@link Keyring.Keyring}, which replaces any
 * header of that name a viewer sent, and the API accepts the current or a retired key. Only then
 * does it trust `CloudFront-Viewer-Address`. The keyring lives in SSM like the other three; a
 * rotation adds the new key behind the current one first (the API accepts both), then moves it to
 * the front and redeploys the distribution.
 */

const ENTRY = /^(\d{1,3}):([A-Za-z0-9_-]+)$/;

/** The header value CloudFront is configured with: `<version>:<base64url secret>`. */
export const headerValue = (keys: Keyring.Keyring): Redacted.Redacted<string> =>
  Redacted.make(`${keys.current.version}:${Base64Url.encode(Redacted.value(keys.current.secret))}`);

/** Whether `presented` is one of the keyring's keys; the secret is compared in constant time. */
export const verify = (keys: Keyring.Keyring, presented: string): boolean => {
  const match = ENTRY.exec(presented);
  if (match === null) return false;
  const secret = Base64Url.decode(match[2] ?? "");
  if (Result.isFailure(secret)) return false;
  return Option.match(Keyring.find(keys, Number(match[1])), {
    onNone: () => false,
    onSome: (key) => constantTimeEqual(Redacted.value(key.secret), secret.success),
  });
};
