import type { Contact } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Button } from "@/components/ui/button";
import { contactsQuery, removeContact, setBlocked } from "@/lib/contacts";

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
  const isBusy = block.isPending || remove.isPending;
  const error = block.error ?? remove.error;

  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 flex-col">
          <span className={contact.isBlocked ? "text-muted-foreground line-through" : ""}>
            {Option.match(contact.name, {
              onNone: () => contact.address,
              onSome: (name) => `${name} <${contact.address}>`,
            })}
          </span>
          <span className="text-xs text-muted-foreground">
            {contact.isBlocked ? "Blocked · " : ""}first wrote{" "}
            {DateTime.format(contact.createdAt, { dateStyle: "medium" })}
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
        <Button variant="ghost" size="sm" disabled={isBusy} onClick={() => remove.mutate()}>
          Remove
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
    </li>
  );
};

/**
 * Everyone who wrote to an alias. Blocking drops their mail (counted as blocked) and replies to
 * them; removing one revokes its reply address for good.
 */
export const ContactList = ({ aliasAddress }: { readonly aliasAddress: string }) => {
  const contacts = useQuery(contactsQuery(aliasAddress));

  if (contacts.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (contacts.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {contacts.error.message}
      </p>
    );
  }
  return Arr.match(contacts.data, {
    onEmpty: () => <p className="text-sm text-muted-foreground">Nobody has written yet.</p>,
    onNonEmpty: (rows) => (
      <ul className="divide-y rounded-md border px-3">
        {Arr.map(rows, (contact) => (
          <ContactRow key={contact.id} aliasAddress={aliasAddress} contact={contact} />
        ))}
      </ul>
    ),
  });
};
