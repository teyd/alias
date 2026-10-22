import { Address } from "@alias/core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Which path an SES recipient takes, decided from the address alone (PLAN.md §3.2).
 * - Forward: mail to an alias, for its owner. `username` names the subdomain's owner for
 *   addresses on a user subdomain, where an unknown alias may be created on the fly.
 * - Reply: mail to a reverse alias `alias+r.<token>@domain`, from the owner back to a contact.
 * - Unroutable: not a valid address.
 *
 * `isCustomDomain`: the domain is none of the shared ones, so it must be a verified custom
 * domain (PLAN.md §20.18.2), which the pipeline looks up.
 */
export type Route = Data.TaggedEnum<{
  Forward: {
    readonly alias: Address.MailAddress;
    readonly username: Option.Option<string>;
    readonly isCustomDomain: boolean;
  };
  Reply: {
    readonly alias: Address.MailAddress;
    readonly token: string;
    readonly isCustomDomain: boolean;
  };
  Unroutable: { readonly reason: "invalid-address" };
}>;
export const Route = Data.taggedEnum<Route>();

export const route = (
  recipient: string,
  sharedDomains: ReadonlyArray<string>,
): Effect.Effect<Route> =>
  Address.parse(recipient).pipe(
    Effect.map((address) => {
      const destination = Address.classify(address, sharedDomains);
      const isCustomDomain = Address.Destination.$is("Custom")(destination);
      return Option.match(Address.reverseToken(address), {
        onNone: () =>
          Route.Forward({
            alias: address,
            username: Address.Destination.$is("UserSubdomain")(destination)
              ? Option.some(destination.username)
              : Option.none(),
            isCustomDomain,
          }),
        onSome: ({ aliasLocal, token }) =>
          Route.Reply({
            alias: { local: aliasLocal, domain: address.domain },
            token,
            isCustomDomain,
          }),
      });
    }),
    Effect.catchTag("InvalidAddress", () =>
      Effect.succeed(Route.Unroutable({ reason: "invalid-address" })),
    ),
  );
