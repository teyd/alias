import { AwsClient, Parameters } from "@alias/aws";
import { Keyring, Seal } from "@alias/core";
import * as SSM from "@distilled.cloud/aws/ssm";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/**
 * Webhook signing secrets at rest (SR-13, PLAN.md §20.30). Signing needs the secret itself, so
 * unlike every other credential in the table it can't be stored as a hash; it is sealed instead
 * (AES-256-GCM, core's `Seal`) with a key-encryption key derived from the webhook keyring, an SSM
 * `SecureString` like the inbox keys (§20.22.2). The API seals (create, rotate); the delivery
 * Lambda opens; nothing else needs the keys (producers only enqueue job ids).
 *
 * Each seal is bound to its owner and webhook as additional authenticated data, so a secret copied
 * to another webhook's item doesn't open. Rotating the secret moves the sealed bytes over as they
 * are: the binding names no slot.
 *
 * Stored blob: `key version (1 byte) || Seal blob`. Opening picks that keyring entry, so after a
 * keyring rotation older secrets keep opening as long as their version stays in the keyring.
 */

/** The keyring that seals webhook secrets. */
export class WebhookKeys extends Context.Service<WebhookKeys, Keyring.Keyring>()(
  "@alias/webhooks/WebhookKeys",
) {}

const KEK_LABEL = "alias/webhook/kek/v1";

/** Whose secret: checked when it is opened. */
export interface Owner {
  readonly userId: string;
  readonly webhookId: string;
}

const aad = (owner: Owner) =>
  `alias/webhook-secret/v1\u0000${owner.userId}\u0000${owner.webhookId}`;

/** Seals `secret` for `owner` with the keyring's current key. */
export const seal = Effect.fn("Secrets.seal")(function* (owner: Owner, secret: Redacted.Redacted) {
  const keys = yield* WebhookKeys;
  const kek = yield* Seal.deriveKey(keys.current, KEK_LABEL);
  const blob = yield* Seal.seal(kek, aad(owner), new TextEncoder().encode(Redacted.value(secret)));
  const stored = new Uint8Array(1 + blob.length);
  stored[0] = keys.current.version;
  stored.set(blob, 1);
  return stored;
});

/** The secret {@link seal} sealed for `owner`, with whichever keyring entry sealed it. */
export const open = Effect.fn("Secrets.open")(function* (owner: Owner, stored: Uint8Array) {
  const keys = yield* WebhookKeys;
  const version = stored[0] ?? -1;
  const entry = yield* Option.match(Keyring.find(keys, version), {
    onNone: () => Effect.fail(new Seal.SealError({ reason: `no webhook key version ${version}` })),
    onSome: Effect.succeed,
  });
  const kek = yield* Seal.deriveKey(entry, KEK_LABEL);
  const plaintext = yield* Seal.open(kek, aad(owner), stored.subarray(1), "webhook secret");
  return Redacted.make(new TextDecoder().decode(plaintext));
});

/**
 * {@link WebhookKeys} from the SSM `SecureString` that `ALIAS_WEBHOOK_KEYS_PARAMETER` names
 * (`<version>:<base64url secret>` entries, the first one sealing; `Parameters.keyring`), read when
 * the layer is built (cold start), with `AWS_ENDPOINT_URL_SSM` only in emulated runs.
 */
export const config = Parameters.keyringConfig("ALIAS_WEBHOOK_KEYS_PARAMETER").pipe(
  Config.map((keys) => Layer.effect(WebhookKeys, keys)),
);

const DEV_KEYS = "1:ZGV2LW9ubHktd2ViaG9vay1rZXktbm90LWEtc2VjcmV0LTE";
const DEV_KEYS_PARAMETER = "/alias/dev/webhook-keys";

/** Puts the dev keys unless they are there, then reads them back like a Lambda. */
const devKeys = Effect.fn("Secrets.devKeys")(function* () {
  yield* SSM.putParameter({
    Name: DEV_KEYS_PARAMETER,
    Type: "SecureString",
    Value: DEV_KEYS,
  }).pipe(Effect.catchTag("ParameterAlreadyExists", () => Effect.void));
  return yield* Parameters.keyring(DEV_KEYS_PARAMETER);
});

/**
 * {@link WebhookKeys} for `pnpm dev` on fakecloud at `url`, shared by the API (sealing) and the
 * delivery Lambda (opening): the fixed dev keys put into fakecloud's SSM as
 * `/alias/dev/webhook-keys` unless that parameter exists, then read back the way the Lambdas read
 * theirs. Anyone with this repo knows the dev key: never use it anywhere real.
 */
export const dev = (url: string) =>
  Layer.effect(
    WebhookKeys,
    devKeys().pipe(
      // fakecloud starts alongside.
      Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
      Effect.provide(AwsClient.emulator(url)),
    ),
  );
