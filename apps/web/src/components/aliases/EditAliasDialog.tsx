import {
  type AliasChanges,
  AliasLabel,
  type AliasView,
  MAX_ALIAS_RECIPIENTS,
  MAX_DESCRIPTION_LENGTH,
  MAX_LABELS,
  type Recipient,
} from "@alias/contracts";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { LoadFailed, Problem } from "@/components/states";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { aliasesQuery, labelsQuery, updateAlias } from "@/lib/aliases";
import { recipientsQuery } from "@/lib/recipients";

const decodeLabel = Schema.decodeUnknownOption(AliasLabel);

/** The labels typed into the field, comma-separated, trimmed, without repeats. */
const parseLabels = (text: string): ReadonlyArray<string> =>
  Arr.dedupe(Arr.filter(Arr.map(Str.split(text, ","), Str.trim), Str.isNonEmpty));

/** What's wrong with the typed labels, if anything. */
const labelsProblem = (text: string): Option.Option<string> => {
  const labels = parseLabels(text);
  if (Arr.length(labels) > MAX_LABELS) return Option.some(`At most ${MAX_LABELS} labels.`);
  return Option.map(
    Arr.findFirst(labels, (label) => Option.isNone(decodeLabel(label))),
    (label) =>
      `“${label}” isn't a label: up to 32 letters, digits, spaces, “.”, “_” or “-”, starting with a letter or digit.`,
  );
};

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  Arr.length(a) === Arr.length(b) && Arr.every(a, (item, index) => b[index] === item);

const EditAliasForm = ({
  alias,
  recipients,
  onSaved,
}: {
  readonly alias: AliasView;
  /** The user's verified destinations. */
  readonly recipients: ReadonlyArray<Recipient>;
  readonly onSaved: () => void;
}) => {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (changes: AliasChanges) => updateAlias(alias.address, changes),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: aliasesQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: labelsQuery.queryKey }),
      ]),
  });
  const defaultValues = {
    description: Option.getOrElse(alias.description, () => ""),
    labels: Arr.join(alias.labels, ", "),
    recipientIds: alias.recipientIds,
  };
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      const description = Str.trim(value.description);
      const labels = parseLabels(value.labels);
      // Only what changed is sent.
      const changes: AliasChanges = {
        ...R.getSomes({
          description: Option.liftPredicate(
            description,
            (text) => text !== Option.getOrElse(alias.description, () => ""),
          ),
        }),
        ...R.getSomes({
          labels: Option.liftPredicate(labels, (list) => !sameList(list, alias.labels)),
          recipientIds: Option.liftPredicate(
            value.recipientIds,
            (ids) => !sameList(ids, alias.recipientIds),
          ),
        }),
      };
      await save.mutateAsync(changes);
      onSaved();
    },
  });
  const fallback = Option.match(
    Arr.findFirst(recipients, (recipient) => recipient.isDefault),
    { onNone: () => "your default destination", onSome: (found) => found.address },
  );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.Field name="description">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="alias-description">Description</FieldLabel>
              <Textarea
                id="alias-description"
                value={field.state.value}
                maxLength={MAX_DESCRIPTION_LENGTH}
                placeholder="What is this alias for?"
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
              />
            </Field>
          )}
        </form.Field>
        <form.Field
          name="labels"
          validators={{
            onChange: ({ value }) => Option.getOrUndefined(labelsProblem(value)),
          }}
        >
          {(field) => (
            <Field data-invalid={Arr.isReadonlyArrayNonEmpty(field.state.meta.errors)}>
              <FieldLabel htmlFor="alias-labels">Labels</FieldLabel>
              <Input
                id="alias-labels"
                value={field.state.value}
                placeholder="shopping, newsletters"
                autoComplete="off"
                aria-invalid={Arr.isReadonlyArrayNonEmpty(field.state.meta.errors)}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
              />
              <FieldDescription>Separate labels with commas.</FieldDescription>
              {Arr.map(field.state.meta.errors, (message) => (
                <FieldError key={String(message)}>{String(message)}</FieldError>
              ))}
            </Field>
          )}
        </form.Field>
        <form.Field name="recipientIds">
          {(field) => (
            <Field>
              <span className="text-sm font-medium">Destinations</span>
              {Arr.match(recipients, {
                onEmpty: () => (
                  <FieldDescription>
                    Confirm a destination first; mail then goes to it.
                  </FieldDescription>
                ),
                onNonEmpty: (verified) => (
                  <div className="flex flex-col gap-2">
                    {Arr.map(verified, (recipient) => {
                      const isChosen = Arr.contains(field.state.value, recipient.id);
                      return (
                        <label
                          key={recipient.id}
                          className="flex items-center justify-between gap-3 text-sm"
                        >
                          <span className="data truncate">{recipient.address}</span>
                          <Switch
                            size="sm"
                            aria-label={`Forward to ${recipient.address}`}
                            checked={isChosen}
                            disabled={
                              !isChosen && Arr.length(field.state.value) >= MAX_ALIAS_RECIPIENTS
                            }
                            onCheckedChange={(isOn) =>
                              field.handleChange(
                                isOn
                                  ? Arr.append(field.state.value, recipient.id)
                                  : Arr.filter(field.state.value, (id) => id !== recipient.id),
                              )
                            }
                          />
                        </label>
                      );
                    })}
                  </div>
                ),
              })}
              <FieldDescription>
                {Arr.isReadonlyArrayEmpty(field.state.value)
                  ? `Default destination (${fallback}).`
                  : `Each chosen destination gets its own copy, up to ${MAX_ALIAS_RECIPIENTS}. Replies work from any of your destinations.`}
              </FieldDescription>
            </Field>
          )}
        </form.Field>
      </FieldGroup>
      <Problem error={save.error} />
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <form.Subscribe selector={(state) => [state.isSubmitting, state.canSubmit] as const}>
          {([isSubmitting, canSubmit]) => (
            <Button type="submit" disabled={isSubmitting || !canSubmit}>
              {isSubmitting ? "Saving…" : "Save alias"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
};

/** Edits the description, labels and destinations of the alias named in `?edit=`. */
export const EditAliasDialog = ({
  alias,
  onClose,
}: {
  readonly alias: Option.Option<AliasView>;
  readonly onClose: () => void;
}) => {
  const recipients = useQuery(recipientsQuery);
  return (
    <Dialog open={Option.isSome(alias)} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit alias</DialogTitle>
          <DialogDescription>
            {Option.match(alias, {
              onNone: () => null,
              onSome: (found) => <span className="data text-foreground">{found.address}</span>,
            })}
          </DialogDescription>
        </DialogHeader>
        {Option.match(alias, {
          onNone: () => null,
          onSome: (found) =>
            recipients.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : recipients.isError ? (
              <LoadFailed what="your destinations" onRetry={() => void recipients.refetch()} />
            ) : (
              <EditAliasForm
                key={found.id}
                alias={found}
                recipients={Arr.filter(recipients.data, (recipient) => recipient.isVerified)}
                onSaved={onClose}
              />
            ),
        })}
      </DialogContent>
    </Dialog>
  );
};
