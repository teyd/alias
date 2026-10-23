import type { Contact } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { BanIcon, UsersIcon } from "lucide-react";
import { LoadFailed, Problem } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { contactsQuery, removeContact, setBlocked } from "@/lib/contacts";
import { blockSender, blocklistQuery } from "@/lib/rules";

const ContactRow = ({
  aliasAddress,
  contact,
}: {
  readonly aliasAddress: string;
  readonly contact: Contact;
}) => {
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: contactsQuery(aliasAddress).queryKey });
  const block = useMutation({
    mutationFn: (isBlocked: boolean) => setBlocked(aliasAddress, contact.id, isBlocked),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => removeContact(aliasAddress, contact.id),
    onSettled: refresh,
  });
  // The blocklist (PLAN.md §20.32): this sender, on every alias.
  const blockEverywhere = useMutation({
    mutationFn: () => blockSender(contact.address, false),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: blocklistQuery.queryKey }),
  });
  const isBusy = block.isPending || remove.isPending || blockEverywhere.isPending;

  return (
    <li className="flex flex-col gap-2 bg-card p-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className={contact.isBlocked ? "text-muted-foreground" : "font-medium"}>
              {Option.getOrElse(contact.name, () => contact.address)}
            </span>
            {contact.isBlocked && (
              <Badge variant="destructive">
                <BanIcon />
                Blocked
              </Badge>
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            {Option.isSome(contact.name) && <span className="data">{contact.address} · </span>}
            first wrote{" "}
            <span className="data">
              {DateTime.format(contact.createdAt, { dateStyle: "medium" })}
            </span>
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={isBusy}
          onClick={() => block.mutate(!contact.isBlocked)}
        >
          {contact.isBlocked ? "Unblock" : "Block"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={isBusy || blockEverywhere.isSuccess}
          onClick={() => blockEverywhere.mutate()}
        >
          {blockEverywhere.isSuccess ? "Blocked everywhere" : "Block everywhere"}
        </Button>
        <Button variant="ghost" size="sm" disabled={isBusy} onClick={() => remove.mutate()}>
          Remove
        </Button>
      </div>
      <Problem error={block.error ?? remove.error ?? blockEverywhere.error} />
    </li>
  );
};

const ContactList = ({ aliasAddress }: { readonly aliasAddress: string }) => {
  const contacts = useQuery(contactsQuery(aliasAddress));

  if (contacts.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (contacts.isError) {
    return <LoadFailed what="the contacts" onRetry={() => void contacts.refetch()} />;
  }
  return Arr.match(contacts.data, {
    onEmpty: () => (
      <div className="flex flex-col items-center gap-2 rounded-lg border bg-muted px-4 py-10 text-center">
        <UsersIcon className="size-4 text-muted-foreground" aria-hidden />
        <p className="text-muted-foreground">Nobody has written to this alias yet.</p>
      </div>
    ),
    onNonEmpty: (rows) => (
      <ul
        aria-label="Contacts"
        className="flex flex-col gap-px overflow-hidden rounded-lg border bg-border"
      >
        {Arr.map(rows, (contact) => (
          <ContactRow key={contact.id} aliasAddress={aliasAddress} contact={contact} />
        ))}
      </ul>
    ),
  });
};

/**
 * Everyone who wrote to the alias named in `?contacts=`. Blocking drops their mail (counted as
 * blocked) and replies to them; removing one revokes its reverse alias for good.
 */
export const ContactsSheet = ({
  aliasAddress,
  onClose,
}: {
  readonly aliasAddress: Option.Option<string>;
  readonly onClose: () => void;
}) => (
  <Sheet open={Option.isSome(aliasAddress)} onOpenChange={(isOpen) => !isOpen && onClose()}>
    <SheetContent side="right" className="w-full sm:max-w-xl">
      {Option.match(aliasAddress, {
        onNone: () => null,
        onSome: (address) => (
          <>
            <SheetHeader>
              <SheetTitle className="data">{address}</SheetTitle>
              <SheetDescription>
                Contacts: everyone who wrote to this alias. Replies to them leave through their own
                reverse alias.
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-4 overflow-auto px-4 pb-4">
              <ContactList aliasAddress={address} />
            </div>
          </>
        ),
      })}
    </SheetContent>
  </Sheet>
);
