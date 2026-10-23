import { AliasClient } from "@alias/sdk";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import type { AliasKind } from "./Messages.ts";
import * as Site from "./Site.ts";

/** How many of the newest aliases the popup lists. */
const RECENT = 5;

/** The alias can't be made here, worded for the person. */
class CannotCreate extends Schema.TaggedError<CannotCreate>()("CannotCreate", {
  message: Schema.String,
}) {}

/**
 * A new alias of `kind` for the page at `pageUrl`: a random one on the first shared domain, or
 * `<site>@<subdomain>` (`example@ada.alias.example` for `shop.example.co.uk`). An alias the user
 * already has for that site is handed out again rather than failing: aliases on their own
 * subdomain are theirs, so a taken one is one they made.
 */
export const create = Effect.fn("Aliases.create")(function* (
  client: AliasClient.Client,
  kind: AliasKind,
  pageUrl: string,
) {
  const domains = yield* client.aliases.domains();
  if (kind === "random") {
    const domain = yield* Option.match(Arr.head(domains.shared), {
      onNone: () => new CannotCreate({ message: "This server offers no shared domain." }),
      onSome: Effect.succeed,
    });
    const alias = yield* client.aliases.create({
      payload: { _tag: "Random", domain, mode: "forward" },
    });
    return { address: alias.address, isNew: true };
  }
  const site = yield* Option.match(Site.fromUrl(pageUrl), {
    onNone: () =>
      new CannotCreate({ message: "This page isn't on a site an alias can be named after." }),
    onSome: Effect.succeed,
  });
  const subdomain = yield* Option.match(Arr.head(domains.subdomains), {
    onNone: () => new CannotCreate({ message: "Your account has no subdomain for named aliases." }),
    onSome: Effect.succeed,
  });
  const address = `${site.localPart}@${subdomain}`;
  return yield* client.aliases
    .create({ payload: { _tag: "Address", address, mode: "forward" } })
    .pipe(
      Effect.map((alias) => ({ address: alias.address, isNew: true })),
      Effect.catchTag("AliasTaken", () =>
        Effect.map(
          client.aliases.lookup({ params: { domain: subdomain, local: site.localPart } }),
          (alias) => ({ address: alias.address, isNew: false }),
        ),
      ),
      Effect.catchTag("InvalidAlias", (error) =>
        Effect.fail(
          new CannotCreate({
            message: `${address} can't be an alias (${error.reason}). Try a random one.`,
          }),
        ),
      ),
    );
});

/** The newest aliases first (ids are ULIDs, so they sort by creation). */
export const recent = Effect.fn("Aliases.recent")(function* (client: AliasClient.Client) {
  const aliases = yield* client.aliases.list();
  return Arr.take(
    Arr.sort(
      aliases,
      Order.flip(Order.mapInput(Order.String, (alias: (typeof aliases)[number]) => alias.id)),
    ),
    RECENT,
  ).map(({ address, isActive }) => ({ address, isActive }));
});
