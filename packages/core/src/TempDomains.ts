import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SharedDomains from "./SharedDomains.ts";

/**
 * The temp-mail domains (`tmp.example`, PLAN.md §3.1, §20.22), lowercased, in the order configured;
 * the first is the default for new temporary inboxes. Empty turns temp mail off. They must be
 * registrable domains of their own, apart from the shared domains, so a blocklisted temp domain
 * can't hurt the aliases: a temp domain that equals, contains or lies under a shared one is
 * refused. The API and the inbound Lambda read them from `ALIAS_TEMP_DOMAINS` through
 * {@link config}.
 */
export class TempDomains extends Context.Service<TempDomains, ReadonlyArray<string>>()(
  "@alias/core/TempDomains",
) {}

class InvalidTempDomains extends Schema.TaggedError<InvalidTempDomains>()("InvalidTempDomains", {
  value: Schema.String,
  reason: Schema.String,
}) {}

const overlaps = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

export const parse = Effect.fn("TempDomains.parse")(function* (
  value: string,
  shared: ReadonlyArray<string>,
) {
  const domains = yield* SharedDomains.parseList(value).pipe(
    Effect.mapError((error) => new InvalidTempDomains({ value, reason: error.reason })),
  );
  const clashing = Arr.filter(domains, (domain) =>
    Arr.some(shared, (sharedDomain) => overlaps(domain, sharedDomain)),
  );
  if (Arr.isArrayNonEmpty(clashing)) {
    return yield* new InvalidTempDomains({
      value,
      reason: `overlaps a shared domain: ${Arr.join(clashing, ", ")}`,
    });
  }
  return domains;
});

/** Checked against the shared domains in context. */
export const layer = (value: string) =>
  Layer.effect(
    TempDomains,
    SharedDomains.SharedDomains.use((shared) => parse(value, shared)),
  );

/** `ALIAS_TEMP_DOMAINS` (unset: temp mail off), checked against `ALIAS_SHARED_DOMAINS`. */
export const config = Config.all({
  value: Config.String("ALIAS_TEMP_DOMAINS").pipe(Config.withDefault("")),
  shared: SharedDomains.config,
}).pipe(
  Config.mapEffect(({ value, shared }) =>
    parse(value, shared).pipe(
      Effect.mapError(
        (error) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: `ALIAS_TEMP_DOMAINS ${error.value}: ${error.reason}`,
            }),
          ),
      ),
    ),
  ),
);
