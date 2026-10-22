import type { InboxView, MessageSummary } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ClockIcon, InboxIcon, MailOpenIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { MessageSheet } from "@/components/inbox/MessageSheet";
import { Page } from "@/components/Page";
import { EmptyState, LoadFailed, Problem, SkeletonRows } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createTemporaryInbox,
  deleteTemporaryInbox,
  inboxesQuery,
  messagesQuery,
} from "@/lib/inboxes";

/** The open inbox and message live in the URL, so both survive a reload and can be linked. */
const Search = Schema.Struct({
  inbox: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});

const when = (at: DateTime.Utc) => DateTime.format(at, { dateStyle: "medium", timeStyle: "short" });

const InboxRow = ({
  inbox,
  isOpen,
  onOpen,
  onDeleted,
}: {
  readonly inbox: InboxView;
  readonly isOpen: boolean;
  readonly onOpen: () => void;
  readonly onDeleted: () => void;
}) => {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteTemporaryInbox(inbox.address),
    onSuccess: () => {
      onDeleted();
      return queryClient.invalidateQueries({ queryKey: inboxesQuery.queryKey });
    },
  });
  return (
    <TableRow data-state={isOpen ? "selected" : undefined}>
      <TableCell>
        <div className="flex items-center gap-1 pl-2">
          <span className="data">{inbox.address}</span>
          <CopyButton text={inbox.address} label="Copy address" />
        </div>
        <Problem error={remove.error} />
      </TableCell>
      <TableCell>
        {Option.match(inbox.expiresAt, {
          onNone: () => (
            <Badge variant="secondary">{inbox.mode === "both" ? "Forward + inbox" : "Inbox"}</Badge>
          ),
          onSome: (expiresAt) => (
            <Badge variant="warning">
              <ClockIcon />
              Temporary · until <span className="data">{when(expiresAt)}</span>
            </Badge>
          ),
        })}
      </TableCell>
      <TableCell className="text-muted-foreground">
        <span className="data">{inbox.retentionDays}</span> day
        {inbox.retentionDays === 1 ? "" : "s"}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          <Button variant={isOpen ? "secondary" : "outline"} size="sm" onClick={onOpen}>
            <MailOpenIcon />
            Open
          </Button>
          {inbox.isTemporary && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${inbox.address}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              <Trash2Icon />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
};

const MessageRow = ({
  message,
  onOpen,
}: {
  readonly message: MessageSummary;
  readonly onOpen: () => void;
}) => (
  <TableRow className="cursor-pointer" onClick={onOpen}>
    <TableCell className="max-w-48 truncate pl-4">
      {Option.getOrElse(message.from, () => "Unknown sender")}
    </TableCell>
    <TableCell className="max-w-80">
      <div className="flex flex-col">
        <span className="truncate font-medium">
          {Option.getOrElse(message.subject, () => "(no subject)")}
        </span>
        <span className="truncate text-xs text-muted-foreground">{message.preview}</span>
      </div>
    </TableCell>
    <TableCell onClick={(event) => event.stopPropagation()}>
      {Option.match(message.code, {
        onNone: () => <span className="text-muted-foreground">—</span>,
        onSome: (code) => (
          <span className="flex items-center gap-1">
            <span className="data font-semibold tracking-widest">{code}</span>
            <CopyButton text={code} label="Copy code" />
          </span>
        ),
      })}
    </TableCell>
    <TableCell className="data text-muted-foreground">{when(message.receivedAt)}</TableCell>
  </TableRow>
);

const Messages = ({
  address,
  onOpenMessage,
}: {
  readonly address: string;
  readonly onOpenMessage: (messageId: string) => void;
}) => {
  const messages = useQuery(messagesQuery(address));
  if (messages.isError) {
    return <LoadFailed what="the messages" onRetry={() => void messages.refetch()} />;
  }
  if (messages.isSuccess && !Arr.isReadonlyArrayNonEmpty(messages.data)) {
    return (
      <EmptyState icon={<InboxIcon />} title="Nothing here yet">
        Mail to <span className="data">{address}</span> shows up here within seconds. Codes and
        sign-in links are picked out for you.
      </EmptyState>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table aria-label="Messages" aria-busy={messages.isPending}>
        <TableHeader>
          <TableRow>
            <TableHead>
              <span className="pl-2">From</span>
            </TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>Code</TableHead>
            <TableHead>Received</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {messages.isPending ? (
            <SkeletonRows columns={4} />
          ) : (
            Arr.map(messages.data, (message) => (
              <MessageRow
                key={message.id}
                message={message}
                onOpen={() => onOpenMessage(message.id)}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
};

/**
 * Inbox mode and temporary inboxes (PLAN.md §20.22): mail kept encrypted instead of forwarded,
 * with one-time codes and sign-in links picked out.
 */
const Inbox = () => {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const inboxes = useQuery(inboxesQuery);
  const queryClient = useQueryClient();
  const openInbox = (address: string) =>
    void navigate({ search: { inbox: address }, replace: true });
  const create = useMutation({
    mutationFn: createTemporaryInbox,
    onSuccess: (created) => {
      openInbox(created.address);
      return queryClient.invalidateQueries({ queryKey: inboxesQuery.queryKey });
    },
  });
  const selected = Option.fromUndefinedOr(search.inbox);
  const newInbox = (
    <Button disabled={create.isPending} onClick={() => create.mutate()}>
      <PlusIcon />
      New temporary inbox
    </Button>
  );

  return (
    <Page title="Inbox" actions={newInbox}>
      <p className="text-muted-foreground">
        Mail kept here is encrypted and deleted after its retention. A temporary inbox takes mail
        for a day; its address is never given to anyone else.
      </p>
      <Problem error={create.error} />

      {inboxes.isError ? (
        <LoadFailed what="your inboxes" onRetry={() => void inboxes.refetch()} />
      ) : inboxes.isSuccess && !Arr.isReadonlyArrayNonEmpty(inboxes.data) ? (
        <EmptyState icon={<InboxIcon />} title="No inboxes yet" action={newInbox}>
          Create a temporary inbox for a sign-up, or give an alias the delivery "Keep in an inbox".
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table aria-label="Inboxes" aria-busy={inboxes.isPending}>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="pl-2">Address</span>
                </TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Keeps mail</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inboxes.isPending ? (
                <SkeletonRows columns={4} />
              ) : (
                Arr.map(inboxes.data, (inbox) => (
                  <InboxRow
                    key={inbox.id}
                    inbox={inbox}
                    isOpen={Option.contains(selected, inbox.address)}
                    onOpen={() => openInbox(inbox.address)}
                    onDeleted={() =>
                      void navigate({
                        search: (current) => Struct.omit(current, ["inbox", "message"]),
                        replace: true,
                      })
                    }
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {Option.match(selected, {
        onNone: () => null,
        onSome: (address) => (
          <section aria-label={`Messages to ${address}`} className="flex flex-col gap-2">
            <h2 className="data text-sm font-semibold">{address}</h2>
            <Messages
              address={address}
              onOpenMessage={(message) =>
                void navigate({ search: (current) => ({ ...current, message }), replace: true })
              }
            />
          </section>
        ),
      })}

      <MessageSheet
        address={selected}
        messageId={Option.fromUndefinedOr(search.message)}
        onClose={() =>
          void navigate({ search: (current) => Struct.omit(current, ["message"]), replace: true })
        }
      />
    </Page>
  );
};

export const Route = createFileRoute("/_app/inbox")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  component: Inbox,
});
