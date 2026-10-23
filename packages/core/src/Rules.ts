import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { decode as decodeWords } from "./internal/encodedWords.ts";

/**
 * A user's rules (PLAN.md §20.32): an ordered list, each with conditions on the incoming mail and
 * actions for mail that meets them. Evaluation is pure and linear in the input: conditions
 * compare case-insensitively with `equals`, `contains`, `starts-with` or `ends-with`, never a
 * regular expression a user wrote (one bad pattern could stall the inbound Lambda: ReDoS).
 *
 * Every enabled rule that matches applies, in order. `block` ends the evaluation after its own
 * rule. A later
 * `set-subject`, `set-display-name` or `forward-to` overrides an earlier one; prefixes stack, the
 * later rule's in front. On the reply path only `block` counts.
 */

export const MAX_RULES = 30;
export const MAX_CONDITIONS = 5;
export const MAX_ACTIONS = 5;
const MAX_NAME_LENGTH = 100;
const MAX_VALUE_LENGTH = 200;
/** What a subject condition looks at: more than any real subject, little enough to stay cheap. */
const MAX_SUBJECT_LENGTH = 2_000;

/**
 * What a condition looks at: the sender's address (`From`, else the envelope sender) or just its
 * domain, the subject, the alias the mail was sent to (`local@domain`), or the alias's labels.
 */
export const Field = Schema.Literals([
  "sender",
  "sender-domain",
  "subject",
  "alias",
  "alias-label",
]);
export type Field = typeof Field.Type;

export const MatchType = Schema.Literals(["equals", "contains", "starts-with", "ends-with"]);
export type MatchType = typeof MatchType.Type;

const Text = (maxLength: number) =>
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maxLength));

export const Condition = Schema.Struct({
  field: Field,
  match: MatchType,
  value: Text(MAX_VALUE_LENGTH),
  /** Met when the comparison fails instead ("does not contain"). */
  isNegated: Schema.Boolean,
});
export type Condition = typeof Condition.Type;

/**
 * - `block`: drop the mail and count it as blocked.
 * - `set-subject` / `prefix-subject`: replace the subject, or put text in front of it.
 * - `set-display-name`: the name the forwarded mail's `From` shows, instead of the sender's.
 * - `skip-tracker-removal`: forward this mail without tracker protection (PLAN.md §20.19).
 * - `skip-encryption`: forward this mail unencrypted to a destination with a key (§20.21).
 * - `forward-to`: this destination instead of the default one, if it is verified and not
 *   bouncing; otherwise the default one.
 * - `webhook`: publish a `rule.matched` event to the owner's webhooks (§20.20).
 */
export const Action = Schema.Union([
  Schema.Struct({ type: Schema.Literal("block") }),
  Schema.Struct({ type: Schema.Literal("set-subject"), value: Text(MAX_VALUE_LENGTH) }),
  Schema.Struct({ type: Schema.Literal("prefix-subject"), value: Text(MAX_VALUE_LENGTH) }),
  Schema.Struct({ type: Schema.Literal("set-display-name"), value: Text(MAX_VALUE_LENGTH) }),
  Schema.Struct({ type: Schema.Literal("skip-tracker-removal") }),
  Schema.Struct({ type: Schema.Literal("skip-encryption") }),
  Schema.Struct({ type: Schema.Literal("forward-to"), recipientId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("webhook") }),
]);
export type Action = typeof Action.Type;

/** A rule as written, without its id. */
export const RuleInput = Schema.Struct({
  name: Text(MAX_NAME_LENGTH),
  isEnabled: Schema.Boolean,
  /** `all`: every condition must be met; `any`: one is enough. */
  match: Schema.Literals(["all", "any"]),
  conditions: Schema.Array(Condition).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CONDITIONS),
  ),
  actions: Schema.Array(Action).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ACTIONS)),
});
export type RuleInput = typeof RuleInput.Type;

export const Rule = Schema.Struct({ id: Schema.String, ...RuleInput.fields });
export type Rule = typeof Rule.Type;

/** What the rules see of a message. */
export interface Message {
  readonly sender: Option.Option<string>;
  /** As in the header: encoded-words are decoded here. */
  readonly subject: Option.Option<string>;
  /** The alias address, `local@domain`. */
  readonly alias: string;
  /** The alias's labels (PLAN.md §20.31). */
  readonly labels: ReadonlyArray<string>;
}

/** How the subject changes: replaced (or kept), with `prefix` in front. */
export interface SubjectChange {
  readonly replacement: Option.Option<string>;
  readonly prefix: string;
}

/** What the matching rules decided. */
export interface Outcome {
  /** Every rule that matched, in order, up to and including a blocking one. */
  readonly matched: ReadonlyArray<string>;
  /** The rule that blocks the mail. */
  readonly blockedBy: Option.Option<string>;
  readonly subject: Option.Option<SubjectChange>;
  readonly displayName: Option.Option<string>;
  readonly recipientId: Option.Option<string>;
  readonly isTrackerRemovalSkipped: boolean;
  readonly isEncryptionSkipped: boolean;
  /** Rules whose `webhook` action fires, in order. */
  readonly notify: ReadonlyArray<string>;
}

const nothing: Outcome = {
  matched: [],
  blockedBy: Option.none(),
  subject: Option.none(),
  displayName: Option.none(),
  recipientId: Option.none(),
  isTrackerRemovalSkipped: false,
  isEncryptionSkipped: false,
  notify: [],
};

/** Case-insensitive, also across Unicode forms (`é` precomposed or not). */
const fold = (text: string) => text.normalize("NFC").toLowerCase();

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

/** What a condition compares: one text, or each of the alias's labels. */
const fieldValues = {
  sender: (message) => [Option.getOrElse(message.sender, () => "")],
  "sender-domain": (message) => [
    Option.match(message.sender, { onNone: () => "", onSome: domainOf }),
  ],
  subject: (message) => [
    Option.match(message.subject, {
      onNone: () => "",
      onSome: (subject) => decodeWords(subject).slice(0, MAX_SUBJECT_LENGTH),
    }),
  ],
  alias: (message) => [message.alias],
  "alias-label": (message) => message.labels,
} satisfies { readonly [K in Field]: (message: Message) => ReadonlyArray<string> };

/** Each is linear in the text: `includes` and friends, never a pattern from the user. */
const comparisons = {
  equals: (actual, expected) => actual === expected,
  contains: (actual, expected) => actual.includes(expected),
  "starts-with": (actual, expected) => actual.startsWith(expected),
  "ends-with": (actual, expected) => actual.endsWith(expected),
} satisfies { readonly [K in MatchType]: (actual: string, expected: string) => boolean };

/**
 * Whether one condition holds for the message. A label condition holds when any label compares
 * true; negated, when none does (an alias without labels has none).
 */
export const meets = (message: Message, condition: Condition): boolean => {
  const expected = fold(Str.trim(condition.value));
  return (
    Arr.some(fieldValues[condition.field](message), (actual) =>
      comparisons[condition.match](fold(Str.trim(actual)), expected),
    ) !== condition.isNegated
  );
};

const matches = (message: Message, rule: RuleInput): boolean =>
  rule.match === "all"
    ? Arr.every(rule.conditions, (condition) => meets(message, condition))
    : Arr.some(rule.conditions, (condition) => meets(message, condition));

const apply = (outcome: Outcome, ruleId: string, action: Action): Outcome =>
  Match.value(action).pipe(
    Match.discriminatorsExhaustive("type")({
      block: (): Outcome => ({ ...outcome, blockedBy: Option.some(ruleId) }),
      "set-subject": ({ value }): Outcome => ({
        ...outcome,
        subject: Option.some({ replacement: Option.some(value), prefix: "" }),
      }),
      "prefix-subject": ({ value }): Outcome => ({
        ...outcome,
        subject: Option.some(
          Option.match(outcome.subject, {
            onNone: () => ({ replacement: Option.none(), prefix: value }),
            onSome: (change) => ({ ...change, prefix: Str.trim(`${value} ${change.prefix}`) }),
          }),
        ),
      }),
      "set-display-name": ({ value }): Outcome => ({
        ...outcome,
        displayName: Option.some(value),
      }),
      "skip-tracker-removal": (): Outcome => ({ ...outcome, isTrackerRemovalSkipped: true }),
      "skip-encryption": (): Outcome => ({ ...outcome, isEncryptionSkipped: true }),
      "forward-to": ({ recipientId }): Outcome => ({
        ...outcome,
        recipientId: Option.some(recipientId),
      }),
      webhook: (): Outcome =>
        Arr.contains(outcome.notify, ruleId)
          ? outcome
          : { ...outcome, notify: [...outcome.notify, ruleId] },
    }),
  );

/** Runs the rules over a message, in order. Disabled rules are skipped. */
export const evaluate = (rules: ReadonlyArray<Rule>, message: Message): Outcome =>
  Arr.reduce(rules, nothing, (outcome, rule) => {
    if (Option.isSome(outcome.blockedBy) || !rule.isEnabled || !matches(message, rule)) {
      return outcome;
    }
    // A blocking rule's other actions still apply: its webhook tells of the blocked mail.
    const matched: Outcome = { ...outcome, matched: Arr.append(outcome.matched, rule.id) };
    return Arr.reduce(rule.actions, matched, (current, action) => apply(current, rule.id, action));
  });

/** The subject a change turns `original` into, as a reader sees it. */
export const changeSubject = (change: SubjectChange, original: string): string => {
  const base = Option.getOrElse(change.replacement, () => original);
  return Str.isEmpty(change.prefix) ? base : Str.trim(`${change.prefix} ${base}`);
};
