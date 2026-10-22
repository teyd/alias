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
import { removeDomain } from "@/lib/domains";
import { useRefreshDomains } from "./refresh";

/** Asks before removing the domain named in `?remove=`, which takes its aliases with it. */
export const RemoveDomainDialog = ({
  domain,
  onClose,
}: {
  readonly domain: Option.Option<string>;
  readonly onClose: () => void;
}) => {
  const refresh = useRefreshDomains();
  const remove = useMutation({
    mutationFn: removeDomain,
    onSuccess: () => {
      void refresh();
      onClose();
    },
  });

  return (
    <Dialog open={Option.isSome(domain)} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        {Option.match(domain, {
          onNone: () => null,
          onSome: (name) => (
            <>
              <DialogHeader>
                <DialogTitle>Remove domain?</DialogTitle>
                <DialogDescription>
                  <span className="data text-foreground">{name}</span> and every alias on it are
                  deleted, and mail to them stops. You can add the domain again later, but its
                  aliases start from scratch.
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
                  {remove.isPending ? "Removing…" : "Remove domain"}
                </Button>
              </DialogFooter>
            </>
          ),
        })}
      </DialogContent>
    </Dialog>
  );
};
