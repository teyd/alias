import type { Rule, RuleTestResult } from "@alias/contracts";
import { useMutation } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Str from "effect/String";
import { FlaskConicalIcon } from "lucide-react";
import { Problem } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { callRules } from "@/lib/rules";

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return P.isString(value) ? Str.trim(value) : "";
};

const optional = (value: string) => (Str.isNonEmpty(value) ? Option.some(value) : Option.none());

/** What the result says, line by line. */
const Verdict = ({
  result,
  rules,
}: {
  readonly result: RuleTestResult;
  readonly rules: ReadonlyArray<Rule>;
}) => {
  const nameOf = (ruleId: string) =>
    Option.match(
      Arr.findFirst(rules, (rule) => rule.id === ruleId),
      { onNone: () => ruleId, onSome: (rule) => rule.name },
    );
  const lines = [
    ...Arr.fromOption(
      Option.map(result.blockedBy, (blocked) =>
        blocked.kind === "blocklist"
          ? `Blocked: ${blocked.entryId} is on your blocklist.`
          : `Blocked by “${nameOf(blocked.ruleId)}”.`,
      ),
    ),
    ...Arr.map(result.matched, (ruleId) => `Matches “${nameOf(ruleId)}”.`),
    ...Arr.fromOption(Option.map(result.subject, (subject) => `Subject: ${subject}`)),
    ...Arr.fromOption(Option.map(result.displayName, (name) => `Shown as: ${name}`)),
    ...(result.isTrackerRemovalSkipped ? ["Trackers are left in."] : []),
    ...(result.isEncryptionSkipped ? ["Not encrypted."] : []),
    ...(Arr.isReadonlyArrayNonEmpty(result.notify) ? ["Your webhooks hear of it."] : []),
  ];
  return (
    <output
      aria-label="Test result"
      className="flex flex-col gap-1 rounded-lg border bg-muted p-3 text-sm"
    >
      {Arr.match(lines, {
        onEmpty: () => <span>No rule matches: the mail is forwarded as usual.</span>,
        onNonEmpty: (all) => Arr.map(all, (line) => <span key={line}>{line}</span>),
      })}
    </output>
  );
};

/** Tries a made-up message on the saved blocklist and rules; nothing is sent or stored. */
export const SampleTester = ({ rules }: { readonly rules: ReadonlyArray<Rule> }) => {
  const test = useMutation({
    mutationFn: (form: FormData) =>
      callRules((api) =>
        api.rules.test({
          payload: {
            sample: {
              sender: optional(text(form, "sender")),
              subject: optional(text(form, "subject")),
              alias: text(form, "alias"),
              labels: Arr.filter(
                Arr.map(text(form, "labels").split(","), Str.trim),
                Str.isNonEmpty,
              ),
            },
          },
        }),
      ),
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        test.mutate(new FormData(event.currentTarget));
      }}
    >
      <div className="grid gap-3 md:grid-cols-4">
        <Field>
          <FieldLabel htmlFor="sample-sender">Sender</FieldLabel>
          <Input
            id="sample-sender"
            name="sender"
            className="data"
            placeholder="news@shop.example"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="sample-subject">Subject</FieldLabel>
          <Input id="sample-subject" name="subject" placeholder="Weekly deals" />
        </Field>
        <Field>
          <FieldLabel htmlFor="sample-alias">Alias</FieldLabel>
          <Input
            id="sample-alias"
            name="alias"
            className="data"
            placeholder="shop@you.alias.example"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="sample-labels">Alias labels</FieldLabel>
          <Input id="sample-labels" name="labels" placeholder="Shopping, Newsletters" />
        </Field>
      </div>
      <Button type="submit" variant="outline" disabled={test.isPending} className="self-start">
        <FlaskConicalIcon />
        Test
      </Button>
      {test.isSuccess && <Verdict result={test.data} rules={rules} />}
      <Problem error={test.error} />
    </form>
  );
};
