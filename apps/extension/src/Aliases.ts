import { type AliasClient, MAX_DESCRIPTION_LENGTH } from "@alias/sdk";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
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
 * The description an alias made here gets: the site it was made for (PLAN.md §20.31), so the
 * user can tell later where they gave it out. Nothing for pages that aren't a site.
 */
const describe = (site: Option.Option<Site.Site>) =>
  Option.match(site, {
    onNone: () => ({}),
    onSome: ({ domain }) => ({
      description: `${domain} (browser extension)`.slice(0, MAX_DESCRIPTION_LENGTH),
    }),
  });

/**
 * A new alias of `kind` for the page at `pageUrl`: a random one on the first shared domain, or
 * `<site>@<subdomain>` (`example@ada.alias.example` for `shop.example.co.uk`) on the subdomain
 * of the username the user picked, the primary one's when none was picked. Either records the
 * site in its description. An alias the user already has for that site is handed out again
 * rather than failing: aliases on their own subdomains are theirs, so a taken one is one they
 * made.
 */
export const create = Effect.fn("Aliases.create")(function* (
  client: AliasClient.Client,
  kind: AliasKind,
  pageUrl: string,
  picked: Option.Option<string>,
) {
  const domains = yield* client.aliases.domains();
  const site = Site.fromUrl(pageUrl);
  if (kind === "random") {
    const domain = yield* Option.match(Arr.head(domains.shared), {
      onNone: () => new CannotCreate({ message: "This server offers no shared domain." }),
      onSome: Effect.succeed,
    });
    const alias = yield* client.aliases.create({
      payload: { _tag: "Random", domain, mode: "forward", ...describe(site) },
    });
    return { address: alias.address, isNew: true };
  }
  const named = yield* Option.match(site, {
    onNone: () =>
      new CannotCreate({ message: "This page isn't on a site an alias can be named after." }),
    onSome: Effect.succeed,
  });
  const subdomain = yield* Option.match(
    Option.match(picked, {
      onNone: () => Arr.head(domains.subdomains),
      onSome: (wanted) => Arr.findFirst(domains.subdomains, (own) => own === wanted),
    }),
    {
      onNone: () =>
        new CannotCreate({
          message: Option.isSome(picked)
            ? `${picked.value} isn't one of your usernames' subdomains.`
            : "Your account has no subdomain for named aliases.",
        }),
      onSome: Effect.succeed,
    },
  );
  const address = `${named.localPart}@${subdomain}`;
  return yield* client.aliases
    .create({ payload: { _tag: "Address", address, mode: "forward", ...describe(site) } })
    .pipe(
      Effect.map((alias) => ({ address: alias.address, isNew: true })),
      Effect.catchTag("AliasTaken", () =>
        Effect.map(
          client.aliases.lookup({ params: { domain: subdomain, local: named.localPart } }),
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

/** The newest aliases first. */
export const recent = Effect.fn("Aliases.recent")(function* (client: AliasClient.Client) {
  const aliases = yield* client.aliases.list();
  return Arr.take(
    Arr.sort(
      aliases,
      Order.flip(
        Order.mapInput(DateTime.Order, (alias: (typeof aliases)[number]) => alias.createdAt),
      ),
    ),
    RECENT,
  ).map(({ address, isActive }) => ({ address, isActive }));
});

/** Where site aliases may go: one subdomain per username, the primary first. */
export const subdomains = Effect.fn("Aliases.subdomains")(function* (client: AliasClient.Client) {
  return (yield* client.aliases.domains()).subdomains;
});
