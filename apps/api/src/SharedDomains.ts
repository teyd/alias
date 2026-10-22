import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Str from "effect/String";

/**
 * The shared mail domains (`alias.example`, …) from `ALIAS_SHARED_DOMAINS`, lowercased. Users get
 * random aliases on them and their own subdomain under each.
 */
export class SharedDomains extends Context.Service<SharedDomains, ReadonlyArray<string>>()(
  "@alias/api/SharedDomains",
) {}

/** Takes the comma-separated `ALIAS_SHARED_DOMAINS` value. */
export const layer = (domains: string) =>
  Layer.succeed(
    SharedDomains,
    Arr.map(Str.split(domains, ","), (domain) => Str.toLowerCase(Str.trim(domain))),
  );
