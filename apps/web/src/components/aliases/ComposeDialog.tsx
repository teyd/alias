import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { SendIcon } from "lucide-react";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { contactsQuery } from "@/lib/contacts";
import { composeMail } from "@/lib/outbox";

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return P.isString(value) ? value : "";
};

/**
 * "Send mail" from one alias (PLAN.md §20.33), held open by `?compose=<alias address>` (and
 * `&to=` when it was opened for a contact). The recipient becomes a contact of the alias; the
 * mail goes out from the alias, so the recipient never sees the owner's mailbox.
 */
export const ComposeDialog = ({
  aliasAddress,
  to,
  onClose,
  onSent,
}: {
  readonly aliasAddress: Option.Option<string>;
  readonly to: Option.Option<string>;
  readonly onClose: () => void;
  readonly onSent: (to: string) => void;
}) => {
  const queryClient = useQueryClient();
  const send = useMutation({
    mutationFn: composeMail,
    onSuccess: (draft) => {
      onSent(draft.to);
      return queryClient.invalidateQueries({ queryKey: contactsQuery(draft.from).queryKey });
    },
  });

  return (
    <Dialog
      open={Option.isSome(aliasAddress)}
      onOpenChange={(open) => !open && onClose()}
      onOpenChangeComplete={(open) => !open && send.reset()}
    >
      <DialogContent className="sm:max-w-lg">
        {Option.match(aliasAddress, {
          onNone: () => null,
          onSome: (from) => (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                send.mutate({
                  from,
                  to: text(form, "to"),
                  subject: text(form, "subject"),
                  text: text(form, "text"),
                });
              }}
            >
              <DialogHeader>
                <DialogTitle>Send mail</DialogTitle>
                <DialogDescription>
                  From <span className="data">{from}</span>. Plain text only. The recipient sees the
                  alias, never your mailbox, and their answers come back through it.
                </DialogDescription>
              </DialogHeader>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="compose-to">To</FieldLabel>
                  <Input
                    id="compose-to"
                    name="to"
                    type="email"
                    className="data"
                    defaultValue={Option.getOrElse(to, () => "")}
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                  <FieldDescription>
                    Someone new becomes a contact of this alias, so you can block them later.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="compose-subject">Subject</FieldLabel>
                  <Input id="compose-subject" name="subject" maxLength={128} required />
                </Field>
                <Field>
                  <FieldLabel htmlFor="compose-text">Message</FieldLabel>
                  <Textarea
                    id="compose-text"
                    name="text"
                    className="min-h-40"
                    maxLength={20_000}
                    required
                  />
                </Field>
              </FieldGroup>
              <Problem error={send.error} />
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button type="submit" disabled={send.isPending}>
                  <SendIcon />
                  {send.isPending ? "Sending…" : "Send"}
                </Button>
              </DialogFooter>
            </form>
          ),
        })}
      </DialogContent>
    </Dialog>
  );
};
