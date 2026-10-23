import * as Blocklist from "@alias/core/Blocklist";
import * as Rules from "@alias/core/Rules";
import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Authentication } from "./Auth.ts";
import { requires } from "./Scopes.ts";

/**
 * The blocklist and the rules (PLAN.md §20.32). Both act on every alias of the caller. Signed in,
 * or a token with `rules:read` / `rules:write`.
 */

export type BlocklistEntry = Blocklist.Entry;
export type Rule = Rules.Rule;
export type RuleInput = Rules.RuleInput;

/** Not an address or a domain that can be blocked. */
export class InvalidBlocklistEntry extends Schema.TaggedError<InvalidBlocklistEntry>()(
  "InvalidBlocklistEntry",
  { reason: Schema.Literals(["invalid-address", "invalid-domain"]) },
  { httpApiStatus: 400 },
) {}

export class BlocklistFull extends Schema.TaggedError<BlocklistFull>()(
  "BlocklistFull",
  { limit: Schema.Number },
  { httpApiStatus: 409 },
) {}

export class BlocklistEntryNotFound extends Schema.TaggedError<BlocklistEntryNotFound>()(
  "BlocklistEntryNotFound",
  { entryId: Schema.String },
  { httpApiStatus: 404 },
) {}

export class TooManyRules extends Schema.TaggedError<TooManyRules>()(
  "TooManyRules",
  { limit: Schema.Number },
  { httpApiStatus: 409 },
) {}

export class RuleNotFound extends Schema.TaggedError<RuleNotFound>()(
  "RuleNotFound",
  { ruleId: Schema.String },
  { httpApiStatus: 404 },
) {}

/** A `forward-to` action names a destination the caller doesn't have. */
export class UnknownRecipient extends Schema.TaggedError<UnknownRecipient>()(
  "UnknownRecipient",
  { recipientId: Schema.String },
  { httpApiStatus: 400 },
) {}

/** A new order must name every rule exactly once. */
export class InvalidRuleOrder extends Schema.TaggedError<InvalidRuleOrder>()(
  "InvalidRuleOrder",
  {},
  { httpApiStatus: 400 },
) {}

/** A message to try the blocklist and rules on. Nothing is sent or stored. */
const Sample = Schema.Struct({
  sender: Schema.OptionFromOptionalKey(Schema.String),
  subject: Schema.OptionFromOptionalKey(Schema.String),
  /** The alias it is sent to, `local@domain`. */
  alias: Schema.String,
  /** That alias's labels, for label conditions; none when left out. */
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const RuleTest = Schema.Struct({
  sample: Sample,
  /** A rule not saved yet, tried alone. Without it, the saved blocklist and rules are tried. */
  rule: Schema.optionalKey(Rules.RuleInput),
});

/** What the sample would go through. `id` of an unsaved rule is `draft`. */
const RuleTestResult = Schema.Struct({
  blockedBy: Schema.OptionFromOptionalKey(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("blocklist"), entryId: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("rule"), ruleId: Schema.String }),
    ]),
  ),
  /** Rules that matched, in order. */
  matched: Schema.Array(Schema.String),
  /** The subject the forwarded mail would have, when a rule changes it. */
  subject: Schema.OptionFromOptionalKey(Schema.String),
  displayName: Schema.OptionFromOptionalKey(Schema.String),
  recipientId: Schema.OptionFromOptionalKey(Schema.String),
  isTrackerRemovalSkipped: Schema.Boolean,
  isEncryptionSkipped: Schema.Boolean,
  /** Rules whose `webhook` action would publish a `rule.matched` event. */
  notify: Schema.Array(Schema.String),
});
export type RuleTestResult = typeof RuleTestResult.Type;

const entryId = { entryId: Schema.String };
const ruleId = { ruleId: Schema.String };

/**
 * Senders blocked across every alias: an address, a domain, or a domain with its subdomains. An
 * entry's id is its stored form (`news@shop.example`, `shop.example`, `*.shop.example`).
 */
export const BlocklistGroup = HttpApiGroup.make("blocklist")
  .add(
    requires("rules:read")(
      HttpApiEndpoint.get("list", "/blocklist", { success: Schema.Array(Blocklist.Entry) }),
    ),
  )
  .add(
    requires("rules:write")(
      HttpApiEndpoint.post("add", "/blocklist", {
        payload: Blocklist.NewEntry,
        success: Blocklist.Entry.pipe(HttpApiSchema.status(201)),
        error: [InvalidBlocklistEntry, BlocklistFull],
      }),
    ),
  )
  .add(
    requires("rules:write")(
      HttpApiEndpoint.delete("remove", "/blocklist/:entryId", {
        params: entryId,
        error: BlocklistEntryNotFound,
      }),
    ),
  )
  .middleware(Authentication)
  .prefix("/v1");

/** Ordered rules: conditions on incoming mail and what to do with mail that meets them. */
export const RulesGroup = HttpApiGroup.make("rules")
  .add(
    requires("rules:read")(
      HttpApiEndpoint.get("list", "/rules", { success: Schema.Array(Rules.Rule) }),
    ),
  )
  .add(
    requires("rules:write")(
      HttpApiEndpoint.post("create", "/rules", {
        payload: Rules.RuleInput,
        success: Rules.Rule.pipe(HttpApiSchema.status(201)),
        error: [TooManyRules, UnknownRecipient],
      }),
    ),
  )
  .add(
    requires("rules:write")(
      HttpApiEndpoint.put("update", "/rules/:ruleId", {
        params: ruleId,
        payload: Rules.RuleInput,
        success: Rules.Rule,
        error: [RuleNotFound, UnknownRecipient],
      }),
    ),
  )
  .add(
    requires("rules:write")(
      HttpApiEndpoint.delete("remove", "/rules/:ruleId", { params: ruleId, error: RuleNotFound }),
    ),
  )
  .add(
    requires("rules:write")(
      HttpApiEndpoint.post("reorder", "/rules/order", {
        payload: Schema.Struct({ ruleIds: Schema.Array(Schema.String) }),
        success: Schema.Array(Rules.Rule),
        error: InvalidRuleOrder,
      }),
    ),
  )
  .add(
    requires("rules:read")(
      HttpApiEndpoint.post("test", "/rules/test", { payload: RuleTest, success: RuleTestResult }),
    ),
  )
  .middleware(Authentication)
  .prefix("/v1");
