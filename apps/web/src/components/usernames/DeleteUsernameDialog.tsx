import { useMutation } from "@tanstack/react-query";
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
import { deleteUsername } from "@/lib/usernames";
import { useRefreshUsernames } from "./refresh";

/** Asks before deleting the username named in `?deleteUsername=`, with every alias on it. */
export const DeleteUsernameDialog = ({
  username,
  onClose,
}: {
  readonly username: Option.Option<string>;
  readonly onClose: () => void;
}) => {
  const refresh = useRefreshUsernames();
  const remove = useMutation({
    mutationFn: deleteUsername,
    onSuccess: () => {
      void refresh();
      onClose();
    },
  });

  return (
    <Dialog open={Option.isSome(username)} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        {Option.match(username, {
          onNone: () => null,
          onSome: (name) => (
            <>
              <DialogHeader>
                <DialogTitle>Delete username?</DialogTitle>
                <DialogDescription>
                  Every alias on <span className="data text-foreground">{name}</span>'s subdomains
                  is deleted with its contacts and kept mail, and mail to them stops. Nobody, you
                  included, can take <span className="data text-foreground">{name}</span> again, so
                  its addresses can't be taken over.
                </DialogDescription>
              </DialogHeader>
              <Problem error={remove.error} />
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(name)}
                >
                  <Trash2Icon />
                  {remove.isPending ? "Deleting…" : "Delete username"}
                </Button>
              </DialogFooter>
            </>
          ),
        })}
      </DialogContent>
    </Dialog>
  );
};
