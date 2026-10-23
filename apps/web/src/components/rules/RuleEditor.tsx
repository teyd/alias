import type { Rule, RuleInput } from "@alias/contracts";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { PlusIcon, XIcon } from "lucide-react";
import { Problem } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { recipientsQuery } from "@/lib/recipients";
import { callRules, rulesQuery } from "@/lib/rules";
import { Choice } from "./Choice";
import { ACTIONS, type ActionType, FIELDS, MATCHES } from "./labels";

/** Conditions and actions per rule, as the API bounds them. */
const MAX_CONDITIONS = 5;
const MAX_ACTIONS = 5;

type Condition = RuleInput["conditions"][number];

/** An action as the form edits it: every input present, read by its type on save. */
interface DraftAction {
  readonly type: ActionType;
  readonly value: string;
  readonly recipientId: string;
}

/** What the form edits; TanStack Form wants mutable arrays. */
interface FormValues {
  name: string;
  match: RuleInput["match"];
  conditions: Array<Condition>;
  actions: Array<DraftAction>;
}

const blankCondition: Condition = {
  field: "sender-domain",
  match: "equals",
  value: "",
  isNegated: false,
};
const blankAction: DraftAction = { type: "prefix-subject", value: "", recipientId: "" };

const draftOf = (action: Rule["actions"][number]): DraftAction => ({
  type: action.type,
  value: "value" in action ? action.value : "",
  recipientId: "recipientId" in action ? action.recipientId : "",
});

const actionOf = (draft: DraftAction): RuleInput["actions"][number] =>
  Match.value(draft.type).pipe(
    Match.when(
      (type) => type === "set-subject" || type === "prefix-subject" || type === "set-display-name",
      (type): RuleInput["actions"][number] => ({ type, value: draft.value }),
    ),
    Match.when("forward-to", (type) => ({ type, recipientId: draft.recipientId })),
    Match.orElse((type) => ({ type })),
  );

const MATCH_ALL = [
  { value: "all", label: "all of these" },
  { value: "any", label: "any of these" },
] as const;

const RuleForm = ({
  rule,
  onSaved,
}: {
  readonly rule: Option.Option<Rule>;
  readonly onSaved: () => void;
}) => {
  const queryClient = useQueryClient();
  const recipients = useQuery(recipientsQuery);
  const destinations = Arr.map(recipients.data ?? [], (recipient) => ({
    value: recipient.id,
    label: recipient.address,
  }));
  const save = useMutation({
    mutationFn: (input: RuleInput) =>
      Option.match(rule, {
        onNone: () => callRules((api) => api.rules.create({ payload: input })),
        onSome: (existing) =>
          callRules((api) => api.rules.update({ params: { ruleId: existing.id }, payload: input })),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: rulesQuery.queryKey }),
  });
  const defaultValues: FormValues = Option.match(rule, {
    onNone: () => ({
      name: "",
      match: "all",
      conditions: [blankCondition],
      actions: [blankAction],
    }),
    onSome: (found) => ({
      name: found.name,
      match: found.match,
      conditions: [...found.conditions],
      actions: Arr.map(found.actions, draftOf),
    }),
  });
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      await save.mutateAsync({
        name: value.name,
        isEnabled: Option.match(rule, { onNone: () => true, onSome: (found) => found.isEnabled }),
        match: value.match,
        conditions: value.conditions,
        actions: Arr.map(value.actions, actionOf),
      });
      onSaved();
    },
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="rule-name">Name</FieldLabel>
            <Input
              id="rule-name"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              placeholder="Newsletters from the shop"
              maxLength={100}
              required
            />
          </Field>
        )}
      </form.Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 flex items-center gap-2 text-sm font-medium">
          When mail meets
          <form.Field name="match">
            {(field) => (
              <Choice
                label="Which conditions"
                value={field.state.value}
                options={MATCH_ALL}
                onChange={field.handleChange}
                className="w-36"
              />
            )}
          </form.Field>
        </legend>
        <form.Field name="conditions" mode="array">
          {(conditions) => (
            <>
              <ul aria-label="Conditions" className="flex flex-col gap-2">
                {Arr.map(conditions.state.value, (_, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- rows have no identity but their place
                  <li key={index} className="flex flex-wrap items-center gap-2">
                    <form.Field name={`conditions[${index}].field`}>
                      {(field) => (
                        <Choice
                          label={`Condition ${index + 1} field`}
                          value={field.state.value}
                          options={FIELDS}
                          onChange={field.handleChange}
                          className="w-36"
                        />
                      )}
                    </form.Field>
                    <form.Field name={`conditions[${index}].isNegated`}>
                      {(field) => (
                        <label className="flex items-center gap-1 text-sm">
                          <input
                            type="checkbox"
                            checked={field.state.value}
                            onChange={(event) => field.handleChange(event.target.checked)}
                          />
                          not
                        </label>
                      )}
                    </form.Field>
                    <form.Field name={`conditions[${index}].match`}>
                      {(field) => (
                        <Choice
                          label={`Condition ${index + 1} comparison`}
                          value={field.state.value}
                          options={MATCHES}
                          onChange={field.handleChange}
                          className="w-32"
                        />
                      )}
                    </form.Field>
                    <form.Field name={`conditions[${index}].value`}>
                      {(field) => (
                        <Input
                          aria-label={`Condition ${index + 1} text`}
                          className="data min-w-40 flex-1"
                          value={field.state.value}
                          onChange={(event) => field.handleChange(event.target.value)}
                          maxLength={200}
                          required
                        />
                      )}
                    </form.Field>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove condition ${index + 1}`}
                      disabled={conditions.state.value.length <= 1}
                      onClick={() => conditions.removeValue(index)}
                    >
                      <XIcon />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={conditions.state.value.length >= MAX_CONDITIONS}
                onClick={() => conditions.pushValue(blankCondition)}
              >
                <PlusIcon />
                Add condition
              </Button>
            </>
          )}
        </form.Field>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Then</legend>
        <form.Field name="actions" mode="array">
          {(actions) => (
            <>
              <ul aria-label="Actions" className="flex flex-col gap-2">
                {Arr.map(actions.state.value, (_, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- rows have no identity but their place
                  <li key={index} className="flex flex-wrap items-center gap-2">
                    <form.Field name={`actions[${index}].type`}>
                      {(type) => (
                        <>
                          <Choice
                            label={`Action ${index + 1}`}
                            value={type.state.value}
                            options={ACTIONS}
                            onChange={type.handleChange}
                            className="w-64"
                          />
                          {Arr.some(
                            ACTIONS,
                            (option) => option.value === type.state.value && option.hasText,
                          ) && (
                            <form.Field name={`actions[${index}].value`}>
                              {(field) => (
                                <Input
                                  aria-label={`Action ${index + 1} text`}
                                  className="min-w-40 flex-1"
                                  value={field.state.value}
                                  onChange={(event) => field.handleChange(event.target.value)}
                                  maxLength={200}
                                  required
                                />
                              )}
                            </form.Field>
                          )}
                          {type.state.value === "forward-to" && (
                            <form.Field name={`actions[${index}].recipientId`}>
                              {(field) => (
                                <Choice
                                  label={`Action ${index + 1} destination`}
                                  value={field.state.value}
                                  options={destinations}
                                  onChange={field.handleChange}
                                  className="data min-w-40 flex-1"
                                />
                              )}
                            </form.Field>
                          )}
                        </>
                      )}
                    </form.Field>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove action ${index + 1}`}
                      disabled={actions.state.value.length <= 1}
                      onClick={() => actions.removeValue(index)}
                    >
                      <XIcon />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={actions.state.value.length >= MAX_ACTIONS}
                onClick={() => actions.pushValue(blankAction)}
              >
                <PlusIcon />
                Add action
              </Button>
            </>
          )}
        </form.Field>
      </fieldset>

      <Problem error={save.error} />
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save rule"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
};

/** Writes a new rule, or changes `rule`; `?dialog=new` or `?edit=<id>` holds it open. */
export const RuleEditor = ({
  isOpen,
  rule,
  onOpenChange,
}: {
  readonly isOpen: boolean;
  readonly rule: Option.Option<Rule>;
  readonly onOpenChange: (isOpen: boolean) => void;
}) => (
  <Dialog open={isOpen} onOpenChange={(open) => onOpenChange(open)}>
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{Option.isSome(rule) ? "Edit rule" : "New rule"}</DialogTitle>
        <DialogDescription>
          Rules apply to mail for every alias, in order. Text compares without regard to case.
        </DialogDescription>
      </DialogHeader>
      {isOpen && (
        <RuleForm
          key={Option.match(rule, { onNone: () => "new", onSome: (found) => found.id })}
          rule={rule}
          onSaved={() => onOpenChange(false)}
        />
      )}
    </DialogContent>
  </Dialog>
);
