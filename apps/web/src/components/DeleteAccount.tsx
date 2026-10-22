import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FingerprintIcon, Trash2Icon } from "lucide-react";
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
import { callApi } from "@/lib/api";
import { eraseAccount } from "@/lib/passkeys";
import { forgetSession } from "@/lib/session";

/**
 * The danger zone: erasing the account (PLAN.md §20.15). The dialog, held open by
 * `?dialog=delete-account`, spells out what goes and what stays, and the erasure itself needs a
 * fresh passkey assertion, so a stolen session cookie can't do it.
 */
export const DeleteAccount = ({
  username,
  isOpen,
  onOpenChange,
}: {
  readonly username: string;
  readonly isOpen: boolean;
  readonly onOpenChange: (isOpen: boolean) => void;
}) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const erase = useMutation({
    mutationFn: () => callApi(eraseAccount),
    onSuccess: () => {
      // The response cleared the session cookie.
      forgetSession(queryClient);
      void navigate({ to: "/" });
    },
  });

  return (
    <>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive p-3">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">Delete account</span>
          <span className="text-xs text-muted-foreground">
            Erases every alias, contact and destination at once. Mail to your aliases is dropped
            from then on.
          </span>
        </div>
        <Button variant="destructive" onClick={() => onOpenChange(true)}>
          <Trash2Icon />
          Delete account
        </Button>
      </div>
      <Dialog
        open={isOpen}
        onOpenChange={(open) => onOpenChange(open)}
        onOpenChangeComplete={(open) => !open && erase.reset()}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete your account for good?</DialogTitle>
            <DialogDescription>
              This can't be undone, and support can't bring anything back.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 rounded-lg border bg-muted p-3">
            <div className="flex flex-col gap-1">
              <span className="font-medium">Erased right away</span>
              <span className="text-muted-foreground">
                Your aliases with their contacts and counters, your destinations, passkeys, sessions
                and settings. Mail to your aliases is dropped from then on, and replies through
                reverse aliases stop working.
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="font-medium">Kept, so nobody can take them over</span>
              <span className="text-muted-foreground">
                The username <span className="data text-foreground">{username}</span> and your
                addresses on shared domains, as bare tombstones with no link to you. Nobody can
                register them again, so mail meant for you never reaches someone else.
              </span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            To confirm, your browser asks for your passkey once more.
          </p>
          <Problem error={erase.error} />
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button variant="destructive" disabled={erase.isPending} onClick={() => erase.mutate()}>
              <FingerprintIcon />
              {erase.isPending ? "Waiting for your passkey…" : "Confirm with passkey"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
