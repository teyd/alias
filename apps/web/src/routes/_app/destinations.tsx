import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { InboxIcon, PlusIcon, ShieldCheckIcon } from "lucide-react";
import { AddDestinationDialog } from "@/components/destinations/AddDestinationDialog";
import { ConfirmFromLink } from "@/components/destinations/ConfirmFromLink";
import { EncryptionDialog } from "@/components/destinations/EncryptionDialog";
import { RecipientRow } from "@/components/destinations/RecipientRow";
import { Page } from "@/components/Page";
import { EmptyState, LoadFailed, SkeletonRows } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { recipientsQuery } from "@/lib/recipients";

/** The confirmation mail links here with the recipient ID and its token. */
const Search = Schema.Struct({
  confirm: Schema.optionalKey(Schema.String),
  token: Schema.optionalKey(Schema.String),
  dialog: Schema.optionalKey(Schema.Literal("add")),
  /** The destination whose encryption dialog is open. */
  encryption: Schema.optionalKey(Schema.String),
});

/** Destinations are the forwarding addresses: real mailboxes, each confirmed by its owner. */
const Destinations = () => {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const recipients = useQuery(recipientsQuery);
  const openAdd = () =>
    void navigate({ search: (current) => ({ ...current, dialog: "add" }), replace: true });
  const closeAdd = () =>
    void navigate({ search: (current) => Struct.omit(current, ["dialog"]), replace: true });
  const openEncryption = (recipientId: string) =>
    void navigate({
      search: (current) => ({ ...current, encryption: recipientId }),
      replace: true,
    });
  const closeEncryption = () =>
    void navigate({ search: (current) => Struct.omit(current, ["encryption"]), replace: true });
  const encrypting = Option.fromUndefinedOr(search.encryption).pipe(
    Option.flatMap((recipientId) =>
      Arr.findFirst(recipients.data ?? [], (recipient) => recipient.id === recipientId),
    ),
  );

  return (
    <Page title="Destinations">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="flex items-center gap-2 text-muted-foreground">
          <ShieldCheckIcon className="size-4 shrink-0" aria-hidden />
          Only verified destinations receive mail. Pending ones are skipped until their owner opens
          the confirmation link.
        </p>
        <Button onClick={openAdd}>
          <PlusIcon />
          Add destination
        </Button>
      </div>

      {P.isString(search.confirm) && P.isString(search.token) && (
        <ConfirmFromLink recipientId={search.confirm} token={search.token} />
      )}

      {recipients.isError ? (
        <LoadFailed what="your destinations" onRetry={() => void recipients.refetch()} />
      ) : recipients.isSuccess && !Arr.isReadonlyArrayNonEmpty(recipients.data) ? (
        <EmptyState
          icon={<InboxIcon />}
          title="No destinations yet"
          action={
            <Button onClick={openAdd}>
              <PlusIcon />
              Add destination
            </Button>
          }
        >
          Add the mailbox your aliases should forward to. We mail it a link to confirm it's yours.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table aria-label="Destinations" aria-busy={recipients.isPending}>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="pl-2">Address</span>
                </TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Added</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recipients.isPending ? (
                <SkeletonRows columns={4} />
              ) : (
                Arr.map(recipients.data, (recipient) => (
                  <RecipientRow
                    key={recipient.id}
                    recipient={recipient}
                    onEncryption={() => openEncryption(recipient.id)}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Every alias forwards to your default destination.
      </p>

      <EncryptionDialog
        recipient={encrypting}
        onOpenChange={(isOpen) => !isOpen && closeEncryption()}
      />
      <AddDestinationDialog
        isOpen={search.dialog === "add"}
        onOpenChange={(isOpen) => (isOpen ? openAdd() : closeAdd())}
      />
    </Page>
  );
};

export const Route = createFileRoute("/_app/destinations")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  component: Destinations,
});
