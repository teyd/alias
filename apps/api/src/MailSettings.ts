import { Address, SharedDomains } from "@alias/core";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** How the service sends its own mail (confirmations). */
export class MailSettings extends Context.Service<
  MailSettings,
  {
    /** Envelope and `From` address, e.g. `no-reply@alias.example`. */
    readonly sender: string;
  }
>()("@alias/api/MailSettings") {}

class InvalidSender extends Schema.TaggedError<InvalidSender>()("InvalidSender", {
  sender: Schema.String,
  reason: Schema.String,
}) {}

/**
 * Checks the sender: it must be an address on one of the shared domains, because those are the
 * identities SES has verified (`infra/alchemy.run.ts`, and `apps/inbound/bin/dev.ts` in dev).
 * Without one, mail goes out as `no-reply@<first shared domain>`.
 */
export const make = Effect.fn("MailSettings.make")(function* (sender: Option.Option<string>) {
  const domains = yield* SharedDomains.SharedDomains;
  const requested = Option.getOrElse(sender, () => `no-reply@${domains[0]}`);
  const address = yield* Address.parse(requested).pipe(
    Effect.mapError((error) => new InvalidSender({ sender: requested, reason: error.reason })),
  );
  if (!Arr.contains(domains, address.domain)) {
    return yield* new InvalidSender({
      sender: requested,
      reason: `not on a shared domain (${Arr.join(domains, ", ")})`,
    });
  }
  return MailSettings.of({ sender: Address.format(address) });
});

export const layer = (sender: Option.Option<string>) => Layer.effect(MailSettings, make(sender));
