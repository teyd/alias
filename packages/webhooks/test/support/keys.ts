import { Keyring } from "@alias/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Secrets } from "../../src/index.ts";

/** A test keyring entry: `1:` and a fixed 32-byte secret (never used anywhere real). */
export const TEST_WEBHOOK_KEYS = "1:dGVzdC1vbmx5LXdlYmhvb2sta2V5LW5vdC1hLXNlY3JldA";

/** `WebhookKeys` from `keys` (`<version>:<base64url secret>` entries, the first one sealing). */
export const testWebhookKeys = (keys = TEST_WEBHOOK_KEYS) =>
  Layer.effect(Secrets.WebhookKeys, Effect.orDie(Keyring.parse(Redacted.make(keys))));
