import type { Rule } from "@alias/contracts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

type Condition = Rule["conditions"][number];
export type ActionType = Rule["actions"][number]["type"];

export const FIELDS: ReadonlyArray<{ readonly value: Condition["field"]; readonly label: string }> =
  [
    { value: "sender", label: "Sender address" },
    { value: "sender-domain", label: "Sender domain" },
    { value: "subject", label: "Subject" },
    { value: "alias", label: "Alias" },
    { value: "alias-label", label: "Alias label" },
  ];

export const MATCHES: ReadonlyArray<{
  readonly value: Condition["match"];
  readonly label: string;
}> = [
  { value: "equals", label: "is" },
  { value: "contains", label: "contains" },
  { value: "starts-with", label: "starts with" },
  { value: "ends-with", label: "ends with" },
];

export const ACTIONS: ReadonlyArray<{
  readonly value: ActionType;
  readonly label: string;
  readonly hasText: boolean;
}> = [
  { value: "block", label: "Block the mail", hasText: false },
  { value: "prefix-subject", label: "Put text in front of the subject", hasText: true },
  { value: "set-subject", label: "Set the subject to", hasText: true },
  { value: "set-display-name", label: "Show the sender as", hasText: true },
  { value: "forward-to", label: "Forward to", hasText: false },
  { value: "skip-tracker-removal", label: "Leave trackers in", hasText: false },
  { value: "skip-encryption", label: "Don't encrypt", hasText: false },
  { value: "webhook", label: "Notify my webhooks", hasText: false },
];

const labelOf = <A extends string>(
  options: ReadonlyArray<{ readonly value: A; readonly label: string }>,
  value: A,
) =>
  Option.match(
    Arr.findFirst(options, (option) => option.value === value),
    { onNone: () => value, onSome: (option) => option.label },
  );

/** "Sender domain is not shop.example". */
export const describeCondition = (condition: Condition) =>
  `${labelOf(FIELDS, condition.field)} ${condition.isNegated ? "not " : ""}${labelOf(MATCHES, condition.match)} “${condition.value}”`;

export const describeAction = (action: Rule["actions"][number]) =>
  "value" in action
    ? `${labelOf(ACTIONS, action.type)} “${action.value}”`
    : labelOf(ACTIONS, action.type);
