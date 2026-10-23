import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Rules } from "../src/index.ts";

const message = (overrides: Partial<Rules.Message> = {}): Rules.Message => ({
  sender: Option.some("News@Shop.Example"),
  subject: Option.some("Your Weekly Deals"),
  alias: "shop@ada.alias.test",
  labels: ["Shopping", "Newsletters"],
  ...overrides,
});

const condition = (
  field: Rules.Field,
  match: Rules.MatchType,
  value: string,
  isNegated = false,
): Rules.Condition => ({ field, match, value, isNegated });

const rule = (
  id: string,
  conditions: ReadonlyArray<Rules.Condition>,
  actions: ReadonlyArray<Rules.Action>,
  overrides: Partial<Rules.Rule> = {},
): Rules.Rule => ({
  id,
  name: id,
  isEnabled: true,
  match: "all",
  conditions,
  actions,
  ...overrides,
});

const block: Rules.Action = { type: "block" };
const webhook: Rules.Action = { type: "webhook" };

describe("Rules.meets", () => {
  // Every field with every match type, met and not met, case-insensitively.
  const cases: ReadonlyArray<readonly [Rules.Field, Rules.MatchType, string, boolean]> = [
    ["sender", "equals", "news@shop.example", true],
    ["sender", "equals", "news@shop", false],
    ["sender", "contains", "@SHOP.", true],
    ["sender", "contains", "deals", false],
    ["sender", "starts-with", "NEWS@", true],
    ["sender", "starts-with", "shop", false],
    ["sender", "ends-with", ".example", true],
    ["sender", "ends-with", "@shop", false],
    ["sender-domain", "equals", "shop.example", true],
    ["sender-domain", "equals", "news@shop.example", false],
    ["sender-domain", "contains", "hop.ex", true],
    ["sender-domain", "contains", "news", false],
    ["sender-domain", "starts-with", "shop", true],
    ["sender-domain", "starts-with", "example", false],
    ["sender-domain", "ends-with", "example", true],
    ["sender-domain", "ends-with", "shop", false],
    ["subject", "equals", "your weekly deals", true],
    ["subject", "equals", "weekly deals", false],
    ["subject", "contains", "WEEKLY", true],
    ["subject", "contains", "monthly", false],
    ["subject", "starts-with", "your", true],
    ["subject", "starts-with", "weekly", false],
    ["subject", "ends-with", "deals", true],
    ["subject", "ends-with", "your", false],
    ["alias", "equals", "SHOP@ada.alias.test", true],
    ["alias", "equals", "shop", false],
    ["alias", "contains", "@ada.", true],
    ["alias", "contains", "bob", false],
    ["alias", "starts-with", "shop@", true],
    ["alias", "starts-with", "ada", false],
    ["alias", "ends-with", "ada.alias.test", true],
    ["alias", "ends-with", "shop", false],
    ["alias-label", "equals", "SHOPPING", true],
    ["alias-label", "equals", "shop", false],
    ["alias-label", "contains", "letter", true],
    ["alias-label", "contains", "work", false],
    ["alias-label", "starts-with", "news", true],
    ["alias-label", "starts-with", "letters", false],
    ["alias-label", "ends-with", "ping", true],
    ["alias-label", "ends-with", "shop", false],
  ];

  it.each(cases)("%s %s %j → %s", (field, match, value, expected) => {
    expect(Rules.meets(message(), condition(field, match, value))).toBe(expected);
    // Negation turns every answer around.
    expect(Rules.meets(message(), condition(field, match, value, true))).toBe(!expected);
  });

  it("compares each of the alias's labels; negated, none may match", () => {
    expect(Rules.meets(message(), condition("alias-label", "equals", "newsletters"))).toBe(true);
    expect(Rules.meets(message(), condition("alias-label", "starts-with", "shop"))).toBe(true);
    expect(Rules.meets(message(), condition("alias-label", "equals", "work"))).toBe(false);
    expect(Rules.meets(message(), condition("alias-label", "equals", "work", true))).toBe(true);
    expect(Rules.meets(message(), condition("alias-label", "contains", "letter", true))).toBe(
      false,
    );
    const unlabelled = message({ labels: [] });
    expect(Rules.meets(unlabelled, condition("alias-label", "contains", "a"))).toBe(false);
    expect(Rules.meets(unlabelled, condition("alias-label", "contains", "a", true))).toBe(true);
  });

  it("covers every field and match type", () => {
    const seen = Arr.dedupe(Arr.map(cases, ([field, match]) => `${field}/${match}`));
    expect(seen).toHaveLength(Rules.Field.literals.length * Rules.MatchType.literals.length);
  });

  it("compares Unicode text in any normalization form and letter case", () => {
    const composed = message({ subject: Option.some("Café ÜBER alles") });
    expect(Rules.meets(composed, condition("subject", "contains", "café über"))).toBe(true);
  });

  it("reads encoded-words in the subject as the reader sees them", () => {
    const encoded = message({ subject: Option.some("=?UTF-8?B?w4RwZmVs?= im Angebot") });
    expect(Rules.meets(encoded, condition("subject", "starts-with", "äpfel"))).toBe(true);
  });

  it("treats a missing sender or subject as empty text", () => {
    const empty = message({ sender: Option.none(), subject: Option.none() });
    expect(Rules.meets(empty, condition("sender", "contains", "@"))).toBe(false);
    expect(Rules.meets(empty, condition("sender-domain", "equals", "shop.example"))).toBe(false);
    expect(Rules.meets(empty, condition("subject", "contains", "a", true))).toBe(true);
  });

  it("ignores whitespace around values", () => {
    expect(Rules.meets(message(), condition("subject", "equals", "  your weekly deals "))).toBe(
      true,
    );
  });

  it("stays fast on a huge subject: no user-written pattern, a bounded prefix", () => {
    const huge = message({ subject: Option.some(`${"a".repeat(2_000_000)}b`) });
    const started = performance.now();
    expect(Rules.meets(huge, condition("subject", "contains", `${"a".repeat(199)}b`))).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("Rules.evaluate", () => {
  it("does nothing without a matching rule", () => {
    const outcome = Rules.evaluate(
      [rule("r1", [condition("subject", "contains", "invoice")], [block])],
      message(),
    );
    expect(outcome.matched).toEqual([]);
    expect(Option.isNone(outcome.blockedBy)).toBe(true);
    expect(outcome.notify).toEqual([]);
  });

  it("needs every condition with `all` and one with `any`", () => {
    const conditions = [
      condition("sender-domain", "equals", "shop.example"),
      condition("subject", "contains", "invoice"),
    ];
    expect(Rules.evaluate([rule("all", conditions, [block])], message()).matched).toEqual([]);
    const any = Rules.evaluate([rule("any", conditions, [block], { match: "any" })], message());
    expect(any.blockedBy).toEqual(Option.some("any"));
  });

  it("skips disabled rules", () => {
    const outcome = Rules.evaluate(
      [rule("off", [condition("sender", "contains", "@")], [block], { isEnabled: false })],
      message(),
    );
    expect(Option.isNone(outcome.blockedBy)).toBe(true);
  });

  it("stops after a blocking rule, whose own webhook still fires", () => {
    const always = condition("alias", "contains", "@");
    const outcome = Rules.evaluate(
      [
        rule("tag", [always], [{ type: "prefix-subject", value: "[a]" }, webhook]),
        rule("stop", [always], [block, webhook]),
        rule("later", [always], [webhook, { type: "set-subject", value: "never" }]),
      ],
      message(),
    );
    expect(outcome.matched).toEqual(["tag", "stop"]);
    expect(outcome.blockedBy).toEqual(Option.some("stop"));
    expect(outcome.notify).toEqual(["tag", "stop"]);
  });

  it("lets later rules override set actions, and stacks prefixes with the later one in front", () => {
    const always = condition("alias", "contains", "@");
    const outcome = Rules.evaluate(
      [
        rule(
          "one",
          [always],
          [
            { type: "prefix-subject", value: "[one]" },
            { type: "set-display-name", value: "First" },
            { type: "forward-to", recipientId: "rc_1" },
          ],
        ),
        rule(
          "two",
          [always],
          [
            { type: "prefix-subject", value: "[two]" },
            { type: "set-display-name", value: "Second" },
            { type: "forward-to", recipientId: "rc_2" },
            { type: "skip-tracker-removal" },
            { type: "skip-encryption" },
          ],
        ),
      ],
      message(),
    );
    expect(outcome.displayName).toEqual(Option.some("Second"));
    expect(outcome.recipientId).toEqual(Option.some("rc_2"));
    expect(outcome.isTrackerRemovalSkipped).toBe(true);
    expect(outcome.isEncryptionSkipped).toBe(true);
    expect(
      Option.map(outcome.subject, (change) => Rules.changeSubject(change, "Your Weekly Deals")),
    ).toEqual(Option.some("[two] [one] Your Weekly Deals"));
  });

  it("drops earlier prefixes when a later rule sets the subject, and prefixes that", () => {
    const always = condition("alias", "contains", "@");
    const outcome = Rules.evaluate(
      [
        rule("one", [always], [{ type: "prefix-subject", value: "[one]" }]),
        rule("two", [always], [{ type: "set-subject", value: "Deals" }]),
        rule("three", [always], [{ type: "prefix-subject", value: "[three]" }]),
      ],
      message(),
    );
    expect(Option.map(outcome.subject, (change) => Rules.changeSubject(change, "ignored"))).toEqual(
      Option.some("[three] Deals"),
    );
  });

  it("names a rule once in notify, however many webhook actions it has", () => {
    const outcome = Rules.evaluate(
      [rule("twice", [condition("alias", "contains", "@")], [webhook, webhook])],
      message(),
    );
    expect(outcome.notify).toEqual(["twice"]);
  });
});

describe("Rules.changeSubject", () => {
  it("prefixes, replaces, and leaves an empty original as just the prefix", () => {
    expect(Rules.changeSubject({ replacement: Option.none(), prefix: "[x]" }, "Hi")).toBe("[x] Hi");
    expect(Rules.changeSubject({ replacement: Option.some("New"), prefix: "" }, "Hi")).toBe("New");
    expect(Rules.changeSubject({ replacement: Option.none(), prefix: "[x]" }, "")).toBe("[x]");
  });
});

describe("Rules.RuleInput", () => {
  const decode = Schema.decodeUnknownExit(Rules.RuleInput);
  const valid = {
    name: "Newsletters",
    isEnabled: true,
    match: "all",
    conditions: [
      { field: "sender-domain", match: "equals", value: "shop.example", isNegated: false },
    ],
    actions: [{ type: "prefix-subject", value: "[news]" }],
  };

  it("accepts a rule and trims its text", () => {
    const decoded = Schema.decodeUnknownSync(Rules.RuleInput)({ ...valid, name: "  News  " });
    expect(decoded.name).toBe("News");
  });

  it("bounds conditions, actions and text, and knows no other field, match or action", () => {
    const tooMany = Arr.replicate(valid.conditions[0], Rules.MAX_CONDITIONS + 1);
    expect(decode({ ...valid, conditions: tooMany })._tag).toBe("Failure");
    expect(decode({ ...valid, conditions: [] })._tag).toBe("Failure");
    expect(decode({ ...valid, actions: Arr.replicate(webhook, Rules.MAX_ACTIONS + 1) })._tag).toBe(
      "Failure",
    );
    expect(decode({ ...valid, actions: [] })._tag).toBe("Failure");
    expect(decode({ ...valid, name: " " })._tag).toBe("Failure");
    expect(decode({ ...valid, name: "x".repeat(101) })._tag).toBe("Failure");
    const value = (text: string) => ({
      ...valid,
      conditions: [{ ...valid.conditions[0], value: text }],
    });
    expect(decode(value("x".repeat(201)))._tag).toBe("Failure");
    expect(decode(value("   "))._tag).toBe("Failure");
    expect(
      decode({ ...valid, conditions: [{ ...valid.conditions[0], match: "regex" }] })._tag,
    ).toBe("Failure");
    expect(decode({ ...valid, conditions: [{ ...valid.conditions[0], field: "body" }] })._tag).toBe(
      "Failure",
    );
    expect(decode({ ...valid, actions: [{ type: "delete-account" }] })._tag).toBe("Failure");
  });
});
