import { Address, SharedDomains } from "@alias/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as AliasRepo from "./AliasRepo.ts";
import * as RecipientRepo from "./RecipientRepo.ts";
import * as UsernameRepo from "./UsernameRepo.ts";

/**
 * Where an alias's forwarded mail goes, shared by the inbound pipeline and the API's resend of a
 * failed delivery (PLAN.md §20.33), so both pick the same mailboxes.
 */

/**
 * Where forwarded mail goes (PLAN.md §20.31, §20.34): the recipients the alias names that still
 * exist and are verified, in the alias's order; when it names none of those, the default
 * recipient of the additional username the alias lives under (`preferred`) while it is one of
 * the owner's verified recipients; else the owner's default recipient, which is always a
 * verified one. None when the owner has no verified recipient.
 */
export const forwardTargets = (
  alias: AliasRepo.Alias,
  recipients: ReadonlyArray<RecipientRepo.Recipient>,
  preferred: Option.Option<string>,
): Option.Option<Arr.NonEmptyReadonlyArray<RecipientRepo.Recipient>> => {
  const verified = (id: string) =>
    Arr.findFirst(
      recipients,
      (recipient) => recipient.id === id && Option.isSome(recipient.verifiedAt),
    );
  const chosen = Arr.filterMap(alias.recipientIds, (id) =>
    Result.fromOption(verified(id), () => undefined),
  );
  if (Arr.isReadonlyArrayNonEmpty(chosen)) return Option.some(chosen);
  return Option.map(
    Option.orElse(Option.flatMap(preferred, verified), () =>
      Arr.findFirst(
        recipients,
        (recipient) => recipient.isDefault && Option.isSome(recipient.verifiedAt),
      ),
    ),
    Arr.of,
  );
};

/**
 * The default recipient of the additional username an alias on a user subdomain lives under
 * (PLAN.md §20.34), if it names one.
 */
const usernameRecipient = Effect.fn("Forwarding.usernameRecipient")(function* (
  alias: AliasRepo.Alias,
) {
  const destination = Address.classify(
    { local: alias.localPart, domain: alias.domain },
    yield* SharedDomains.SharedDomains,
  );
  if (!Address.Destination.$is("UserSubdomain")(destination)) return Option.none<string>();
  const entry = yield* (yield* UsernameRepo.UsernameRepo).find(alias.userId, destination.username);
  return Option.flatMap(entry, (found) => found.defaultRecipientId);
});

/** The owner's recipients, and the ones the alias's mail goes to ({@link forwardTargets}). */
export const targetsOf = Effect.fn("Forwarding.targetsOf")(function* (alias: AliasRepo.Alias) {
  const recipients = yield* (yield* RecipientRepo.RecipientRepo).list(alias.userId);
  return {
    recipients,
    targets: forwardTargets(alias, recipients, yield* usernameRecipient(alias)),
  };
});
