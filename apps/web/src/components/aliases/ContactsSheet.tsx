import type { Contact } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { BanIcon, SendIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { LoadFailed, Problem } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { addContact, contactsQuery, removeContact, setBlocked } from "@/lib/contacts";
import { blockSender, blocklistQuery } from "@/lib/rules";

const ContactRow = ({
  aliasAddress,
  contact,
  onWrite,
}: {
  readonly aliasAddress: string;
  readonly contact: Contact;
  readonly onWrite: () => void;
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
        {!contact.isBlocked && (
          <Button variant="ghost" size="sm" disabled={isBusy} onClick={onWrite}>
            <SendIcon />
            Write
          </Button>
        )}
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

/**
 * Adds someone to write to first (PLAN.md §20.33) and shows their send-to address: the contact's
 * reverse alias, which the owner mails from a verified destination to send as the alias.
 */
const AddContact = ({ aliasAddress }: { readonly aliasAddress: string }) => {
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: (address: string) => addContact(aliasAddress, address),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: contactsQuery(aliasAddress).queryKey }),
  });
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const address = new FormData(event.currentTarget).get("address");
          add.mutate(P.isString(address) ? address : "");
        }}
      >
        <Field className="flex-1">
          <FieldLabel htmlFor="contact-address">Contact address</FieldLabel>
          <Input
            id="contact-address"
            name="address"
            type="email"
            className="data"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </Field>
        <Button type="submit" variant="outline" disabled={add.isPending}>
          <UserPlusIcon />
          Add contact
        </Button>
      </form>
      <Problem error={add.error} />
      {add.isSuccess && (
        <div className="flex flex-col gap-1 rounded-lg bg-muted p-3">
          <span className="text-xs text-muted-foreground">
            Send-to address for <span className="data">{add.data.address}</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="data truncate">{add.data.replyAddress}</span>
            <CopyButton text={add.data.replyAddress} label="Copy send-to address" />
          </span>
          <FieldDescription>
            Mail this address from your verified destination, and it goes out to{" "}
            <span className="data">{add.data.address}</span> from the alias. Your mailbox isn't
            shown.
          </FieldDescription>
        </div>
      )}
    </div>
  );
};

const ContactList = ({
  aliasAddress,
  onWrite,
}: {
  readonly aliasAddress: string;
  readonly onWrite: (to: string) => void;
}) => {
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
        <p className="text-muted-foreground">
          Nobody has written to this alias yet. Add someone above to write to them first.
        </p>
      </div>
    ),
    onNonEmpty: (rows) => (
      <ul
        aria-label="Contacts"
        className="flex flex-col gap-px overflow-hidden rounded-lg border bg-border"
      >
        {Arr.map(rows, (contact) => (
          <ContactRow
            key={contact.id}
            aliasAddress={aliasAddress}
            contact={contact}
            onWrite={() => onWrite(contact.address)}
          />
        ))}
      </ul>
    ),
  });
};

/**
 * Everyone who wrote to the alias named in `?contacts=`, or whom the owner added to write to.
 * Blocking drops their mail (counted as blocked) and replies to them; removing one revokes its
 * reverse alias for good.
 */
export const ContactsSheet = ({
  aliasAddress,
  onClose,
  onWrite,
}: {
  readonly aliasAddress: Option.Option<string>;
  readonly onClose: () => void;
  readonly onWrite: (aliasAddress: string, to: string) => void;
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
              <AddContact aliasAddress={address} />
              <ContactList aliasAddress={address} onWrite={(to) => onWrite(address, to)} />
            </div>
          </>
        ),
      })}
    </SheetContent>
  </Sheet>
);
