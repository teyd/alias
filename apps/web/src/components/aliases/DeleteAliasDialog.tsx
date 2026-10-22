import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Option from "effect/Option";
import { BanIcon, Trash2Icon } from "lucide-react";
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
import { aliasesQuery, deleteAlias, setActive } from "@/lib/aliases";

/**
 * Asks before deleting the alias named in `?delete=`. Deleting can't be undone (PLAN.md §20.15),
 * so the dialog offers the everyday alternative, deactivating, right next to it.
 */
export const DeleteAliasDialog = ({
  aliasAddress,
  onClose,
}: {
  readonly aliasAddress: Option.Option<string>;
  readonly onClose: () => void;
}) => {
  const queryClient = useQueryClient();
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: aliasesQuery.queryKey });
    onClose();
  };
  const remove = useMutation({ mutationFn: deleteAlias, onSuccess: done });
  const deactivate = useMutation({
    mutationFn: (address: string) => setActive(address, false),
    onSuccess: done,
  });
  const isBusy = remove.isPending || deactivate.isPending;

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
                  <span className="data text-foreground">{address}</span> goes for good: its
                  contacts and counters are erased, replies to them stop working, and nobody else
                  can ever use the address. To stop its mail for now, deactivate it instead.
                </DialogDescription>
              </DialogHeader>
              <Problem error={remove.error ?? deactivate.error} />
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button
                  variant="outline"
                  disabled={isBusy}
                  onClick={() => deactivate.mutate(address)}
                >
                  <BanIcon />
                  Deactivate instead
                </Button>
                <Button
                  variant="destructive"
                  disabled={isBusy}
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
