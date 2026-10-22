import { Address } from "@alias/core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Which path an SES recipient takes, decided from the address alone (PLAN.md §3.2).
 * - Forward: mail to an alias, for its owner.
 * - Reply: mail to a reverse alias `alias+r.<token>@domain`, from the owner back to a contact.
 * - Unroutable: not an address we serve. Custom domains arrive with roadmap phase 5.
 */
export type Route = Data.TaggedEnum<{
  Forward: { readonly alias: Address.MailAddress };
  Reply: { readonly alias: Address.MailAddress; readonly token: string };
  Unroutable: { readonly reason: "invalid-address" | "custom-domain" };
}>;
export const Route = Data.taggedEnum<Route>();

export const route = (
  recipient: string,
  sharedDomains: ReadonlyArray<string>,
): Effect.Effect<Route> =>
  Address.parse(recipient).pipe(
    Effect.map((address) =>
      Address.Destination.$is("Custom")(Address.classify(address, sharedDomains))
        ? Route.Unroutable({ reason: "custom-domain" })
        : Option.match(Address.reverseToken(address), {
            onNone: () => Route.Forward({ alias: address }),
            onSome: ({ aliasLocal, token }) =>
              Route.Reply({ alias: { local: aliasLocal, domain: address.domain }, token }),
          }),
    ),
    Effect.catchTag("InvalidAddress", () =>
      Effect.succeed(Route.Unroutable({ reason: "invalid-address" })),
    ),
  );
