import type { Recipient } from "@alias/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  EllipsisIcon,
  SendIcon,
  StarIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { Problem } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TableCell, TableRow } from "@/components/ui/table";
import { callRecipients, recipientsQuery } from "@/lib/recipients";

/** One call per row action; each settles to nothing. */
const rowActions = {
  resend: (recipientId: string) =>
    callRecipients((api) => api.recipients.resend({ params: { recipientId } })),
  makeDefault: (recipientId: string) =>
    callRecipients((api) => api.recipients.makeDefault({ params: { recipientId } })),
  remove: (recipientId: string) =>
    callRecipients((api) => api.recipients.remove({ params: { recipientId } })),
} as const;

const date = (at: DateTime.Utc) => DateTime.format(at, { dateStyle: "medium" });

/** Green, amber and red are status only: confirmed, waiting, bouncing. */
const Status = ({ recipient }: { readonly recipient: Recipient }) =>
  Option.isSome(recipient.bouncedAt) ? (
    <Badge variant="destructive">
      <CircleXIcon />
      Bounced
    </Badge>
  ) : recipient.isVerified ? (
    <Badge variant="success">
      <CircleCheckIcon />
      Verified
    </Badge>
  ) : (
    <Badge variant="warning">
      <ClockIcon />
      Pending
    </Badge>
  );

/** What the status means for this mailbox, and how to fix it. */
const Note = ({ recipient }: { readonly recipient: Recipient }) =>
  Option.match(recipient.bouncedAt, {
    onSome: (at) => (
      <span className="text-destructive">
        Bounced on <span className="data">{date(at)}</span>: nothing is forwarded here.{" "}
        {recipient.isVerified
          ? "Remove it and add it again to retry."
          : "Resend the link to retry."}
      </span>
    ),
    onNone: () =>
      Option.match(recipient.complainedAt, {
        onSome: (at) => (
          <span className="flex items-center gap-1">
            <TriangleAlertIcon className="size-3 text-warning" aria-hidden />
            Marked forwarded mail as spam on <span className="data">{date(at)}</span>. Block the
            sender on its alias instead.
          </span>
        ),
        onNone: () =>
          recipient.isVerified ? null : <span>Waiting for the confirmation link.</span>,
      }),
  });

export const RecipientRow = ({ recipient }: { readonly recipient: Recipient }) => {
  const queryClient = useQueryClient();
  const action = useMutation({
    mutationFn: (kind: keyof typeof rowActions) => rowActions[kind](recipient.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: recipientsQuery.queryKey }),
  });

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-1 pl-2">
          <span className="data">{recipient.address}</span>
          <CopyButton text={recipient.address} label="Copy address" />
          {recipient.isDefault && <Badge variant="outline">Default</Badge>}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <Status recipient={recipient} />
          <span className="text-xs whitespace-normal text-muted-foreground">
            <Note recipient={recipient} />
          </span>
          {action.isSuccess && action.variables === "resend" && (
            <span className="text-xs text-muted-foreground">A new link is on its way.</span>
          )}
          <Problem error={action.error} />
        </div>
      </TableCell>
      <TableCell className="data text-xs text-muted-foreground">
        {date(recipient.createdAt)}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1 pr-1">
          {!recipient.isVerified && (
            <Button
              variant="outline"
              size="xs"
              disabled={action.isPending}
              onClick={() => action.mutate("resend")}
            >
              <SendIcon />
              Resend link
            </Button>
          )}
          {recipient.isVerified && !recipient.isDefault && (
            <Button
              variant="outline"
              size="xs"
              disabled={action.isPending}
              onClick={() => action.mutate("makeDefault")}
            >
              <StarIcon />
              Make default
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label="Destination actions" />}
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="data">{recipient.address}</DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={action.isPending}
                onClick={() => action.mutate("remove")}
              >
                <Trash2Icon />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );
};
