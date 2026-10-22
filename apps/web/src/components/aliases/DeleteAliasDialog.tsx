import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Option from "effect/Option";
import { Trash2Icon } from "lucide-react";
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
import { aliasesQuery, deleteAlias } from "@/lib/aliases";

/** Asks before deleting the alias named in `?delete=`; deleting can't be undone. */
export const DeleteAliasDialog = ({
  aliasAddress,
  onClose,
}: {
  readonly aliasAddress: Option.Option<string>;
  readonly onClose: () => void;
}) => {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: deleteAlias,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aliasesQuery.queryKey });
      onClose();
    },
  });

  return (
    <Dialog open={Option.isSome(aliasAddress)} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        {Option.match(aliasAddress, {
          onNone: () => null,
          onSome: (address) => (
            <>
              <DialogHeader>
                <DialogTitle>Delete alias?</DialogTitle>
                <DialogDescription>
                  Mail to <span className="data text-foreground">{address}</span> is dropped from
                  now on, and replies through its reverse aliases stop working (unless on-the-fly
                  aliases create it again). This can't be undone; to pause an alias, deactivate it.
                </DialogDescription>
              </DialogHeader>
              <Problem error={remove.error} />
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(address)}
                >
                  <Trash2Icon />
                  {remove.isPending ? "Deleting…" : "Delete"}
                </Button>
              </DialogFooter>
            </>
          ),
        })}
      </DialogContent>
    </Dialog>
  );
};
