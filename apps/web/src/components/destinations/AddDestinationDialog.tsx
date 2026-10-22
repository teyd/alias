import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as P from "effect/Predicate";
import { MailIcon, SendIcon } from "lucide-react";
import { Problem } from "@/components/states";
import { Badge } from "@/components/ui/badge";
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
import { callRecipients, recipientsQuery } from "@/lib/recipients";

/**
 * "Add destination", held open by `?dialog=add`. After sending it turns into the design's
 * "Check your inbox" step.
 */
export const AddDestinationDialog = ({
  isOpen,
  onOpenChange,
}: {
  readonly isOpen: boolean;
  readonly onOpenChange: (isOpen: boolean) => void;
}) => {
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: (address: string) =>
      callRecipients((api) => api.recipients.add({ payload: { address } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: recipientsQuery.queryKey }),
  });

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => onOpenChange(open)}
      onOpenChangeComplete={(open) => !open && add.reset()}
    >
      <DialogContent className="sm:max-w-md">
        {add.isSuccess ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <MailIcon className="size-4" aria-hidden />
                Check your inbox
              </DialogTitle>
              <DialogDescription>
                Open the link we sent while you're signed in here, to confirm you control this
                address. Nothing is forwarded to it before that.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2 rounded-lg border bg-muted p-3">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Sent to</span>
                <span className="data">{add.data.address}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Status</span>
                <Badge variant="warning">Pending</Badge>
              </div>
            </div>
            <DialogFooter>
              <DialogClose render={<Button />}>Done</DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const address = new FormData(event.currentTarget).get("address");
              add.mutate(P.isString(address) ? address : "");
            }}
          >
            <DialogHeader>
              <DialogTitle>Add destination</DialogTitle>
              <DialogDescription>
                We send a confirmation link to this mailbox. It receives mail only after the link is
                opened.
              </DialogDescription>
            </DialogHeader>
            <Field data-invalid={add.isError || undefined}>
              <FieldLabel htmlFor="destination-address">Mailbox address</FieldLabel>
              <Input
                id="destination-address"
                name="address"
                type="email"
                className="data"
                autoComplete="email"
                placeholder="you@example.com"
                aria-invalid={add.isError}
                required
              />
              <FieldDescription>Aliases can forward here once it's confirmed.</FieldDescription>
            </Field>
            <Problem error={add.error} />
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
              <Button type="submit" disabled={add.isPending}>
                <SendIcon />
                {add.isPending ? "Sending…" : "Send confirmation"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};
