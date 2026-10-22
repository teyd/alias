import { Address } from "@alias/core";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/** How the service sends its own mail (confirmations), and which domains are ours. */
export class MailSettings extends Context.Service<
  MailSettings,
  {
    /** Envelope and `From` address, e.g. `no-reply@alias.example`. */
    readonly sender: string;
    /** The shared alias domains, lowercased. SES has each one verified as a sending identity. */
    readonly aliasDomains: ReadonlyArray<string>;
  }
>()("@alias/api/MailSettings") {}

class InvalidSender extends Schema.TaggedError<InvalidSender>()("InvalidSender", {
  sender: Schema.String,
  reason: Schema.String,
}) {}

/**
 * Checks the sender: it must be an address on one of the shared domains, because those are the
 * identities SES has verified (`infra/alchemy.run.ts`, and `tools/ses-emulator` in dev).
 */
export const make = Effect.fn("MailSettings.make")(function* (settings: {
  readonly sender: string;
  readonly aliasDomains: ReadonlyArray<string>;
}) {
  const aliasDomains = Arr.map(settings.aliasDomains, Str.toLowerCase);
  const sender = yield* Address.parse(settings.sender).pipe(
    Effect.mapError(
      (error) => new InvalidSender({ sender: settings.sender, reason: error.reason }),
    ),
  );
  if (!Arr.contains(aliasDomains, sender.domain)) {
    return yield* new InvalidSender({
      sender: settings.sender,
      reason: `not on a shared domain (${Arr.join(aliasDomains, ", ")})`,
    });
  }
  return MailSettings.of({ sender: `${sender.local}@${sender.domain}`, aliasDomains });
});

export const layer = (settings: Parameters<typeof make>[0]) =>
  Layer.effect(MailSettings, make(settings));
