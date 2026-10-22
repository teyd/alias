import { useMutation } from "@tanstack/react-query";
import * as P from "effect/Predicate";
import { PlusIcon } from "lucide-react";
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
import { addDomain } from "@/lib/domains";
import { useRefreshDomains } from "./refresh";

/** "Add domain", held open by `?dialog=add-domain`. The new domain then shows its DNS records. */
export const AddDomainDialog = ({
  isOpen,
  onOpenChange,
}: {
  readonly isOpen: boolean;
  readonly onOpenChange: (isOpen: boolean) => void;
}) => {
  const refresh = useRefreshDomains();
  const add = useMutation({
    mutationFn: addDomain,
    onSuccess: () => {
      void refresh();
      onOpenChange(false);
    },
  });

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => onOpenChange(open)}
      onOpenChangeComplete={(open) => !open && add.reset()}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const domain = new FormData(event.currentTarget).get("domain");
            add.mutate(P.isString(domain) ? domain : "");
          }}
        >
          <DialogHeader>
            <DialogTitle>Add a custom domain</DialogTitle>
            <DialogDescription>
              Next you publish a few DNS records at your DNS provider. Your website and other mail
              stay where they are; only the domain's MX record changes, so use a domain (or
              subdomain) that receives no other mail.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={add.isError || undefined}>
            <FieldLabel htmlFor="custom-domain">Domain</FieldLabel>
            <Input
              id="custom-domain"
              name="domain"
              className="data"
              placeholder="example.com"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={add.isError}
              required
            />
            <FieldDescription>
              It stays pending until its records are published, for up to three days.
            </FieldDescription>
          </Field>
          <Problem error={add.error} />
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" disabled={add.isPending}>
              <PlusIcon />
              {add.isPending ? "Adding…" : "Add domain"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
