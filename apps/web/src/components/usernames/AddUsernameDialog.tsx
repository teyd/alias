import { useForm, useStore } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import * as Str from "effect/String";
import { PlusIcon } from "lucide-react";
import { HumanCheck } from "@/components/HumanCheck";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { addUsername } from "@/lib/usernames";
import { useRefreshUsernames } from "./refresh";

const AddUsernameForm = ({ onAdded }: { readonly onAdded: () => void }) => {
  const refresh = useRefreshUsernames();
  const add = useMutation({
    mutationFn: addUsername,
    onSuccess: () => {
      void refresh();
      onAdded();
    },
  });
  const form = useForm({
    defaultValues: { username: "", turnstileToken: "" },
    onSubmit: ({ value }) => add.mutate(value),
  });
  const hasToken = useStore(form.store, (state) => Str.isNonEmpty(state.values.turnstileToken));

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="username">
        {(field) => (
          <Field data-invalid={add.isError || undefined}>
            <FieldLabel htmlFor="new-username">Username</FieldLabel>
            <Input
              id="new-username"
              className="data"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              placeholder="ada-work"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={add.isError}
              required
            />
            <FieldDescription>
              Lowercase letters, digits and single hyphens. Once added, a username is never given to
              anyone else, even after you delete it.
            </FieldDescription>
          </Field>
        )}
      </form.Field>
      {/* A new widget for every attempt, since each token is redeemed once. */}
      <HumanCheck
        key={add.submittedAt}
        onToken={(token) => form.setFieldValue("turnstileToken", token)}
      />
      <Problem error={add.error} />
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <Button type="submit" disabled={add.isPending || !hasToken}>
          <PlusIcon />
          {add.isPending ? "Adding…" : hasToken ? "Add username" : "Checking you're human…"}
        </Button>
      </DialogFooter>
    </form>
  );
};

/** "Add username", held open by `?dialog=add-username`. */
export const AddUsernameDialog = ({
  isOpen,
  onOpenChange,
}: {
  readonly isOpen: boolean;
  readonly onOpenChange: (isOpen: boolean) => void;
}) => (
  <Dialog open={isOpen} onOpenChange={(open) => onOpenChange(open)}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Add a username</DialogTitle>
        <DialogDescription>
          It gets its own subdomain, to keep aliases apart (work and personal, say), with its own
          on-the-fly setting and destination. You keep signing in as before.
        </DialogDescription>
      </DialogHeader>
      {isOpen && <AddUsernameForm onAdded={() => onOpenChange(false)} />}
    </DialogContent>
  </Dialog>
);
