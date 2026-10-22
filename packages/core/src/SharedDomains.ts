import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { isDomain } from "./Address.ts";

/**
 * The shared mail domains (`alias.example`, …), lowercased, in the order configured. Users get
 * random aliases on them and their own subdomain under each, and SES has each one verified as a
 * sending identity. The API and the inbound Lambda both read them from `ALIAS_SHARED_DOMAINS`
 * through {@link config}, so the two can't disagree about which domains are ours.
 */
export class SharedDomains extends Context.Service<
  SharedDomains,
  Arr.NonEmptyReadonlyArray<string>
>()("@alias/core/SharedDomains") {}

class InvalidSharedDomains extends Schema.TaggedError<InvalidSharedDomains>()(
  "InvalidSharedDomains",
  { value: Schema.String, reason: Schema.String },
) {}

/**
 * A comma-separated list of domains such as `alias.example, Alias2.example`: lowercased, trimmed
 * and deduplicated, in the order given. It may be empty.
 */
export const parseList = Effect.fn("SharedDomains.parseList")(function* (value: string) {
  const domains = Arr.dedupe(
    Arr.filter(
      Arr.map(Str.split(value, ","), (domain) => Str.toLowerCase(Str.trim(domain))),
      Str.isNonEmpty,
    ),
  );
  const invalid = Arr.filter(domains, (domain) => !isDomain(domain));
  if (Arr.isArrayNonEmpty(invalid)) {
    return yield* new InvalidSharedDomains({
      value,
      reason: `not a domain: ${Arr.join(invalid, ", ")}`,
    });
  }
  return domains;
});

/** Parses the shared domains: a {@link parseList} list of at least one. */
export const parse = Effect.fn("SharedDomains.parse")(function* (value: string) {
  const domains = yield* parseList(value);
  if (!Arr.isArrayNonEmpty(domains)) {
    return yield* new InvalidSharedDomains({ value, reason: "no domain given" });
  }
  return domains;
});

export const layer = (value: string) => Layer.effect(SharedDomains, parse(value));

/** `ALIAS_SHARED_DOMAINS`, parsed. A bad value fails the cold start, not every request. */
export const config = Config.String("ALIAS_SHARED_DOMAINS").pipe(
  Config.mapEffect((value) =>
    parse(value).pipe(
      Effect.mapError(
        (error) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: `ALIAS_SHARED_DOMAINS ${error.value}: ${error.reason}`,
            }),
          ),
      ),
    ),
  ),
);
