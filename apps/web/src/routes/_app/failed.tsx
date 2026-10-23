import type { FailedDelivery } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { DownloadIcon, MailWarningIcon, RotateCwIcon, Trash2Icon } from "lucide-react";
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
import { aliasesQuery } from "@/lib/aliases";
import {
  REASONS,
  deleteFailure,
  downloadFailure,
  failuresQuery,
  resendFailure,
} from "@/lib/failures";

const when = (at: DateTime.Utc) => DateTime.format(at, { dateStyle: "medium", timeStyle: "short" });

/** Hands the kept copy to the browser as an `.eml` file. */
const save = (failureId: string, bytes: Uint8Array) => {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "message/rfc822" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${failureId}.eml`;
  link.click();
  URL.revokeObjectURL(url);
};

const FailureRow = ({ failure }: { readonly failure: FailedDelivery }) => {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: failuresQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: aliasesQuery.queryKey }),
    ]);
  const download = useMutation({
    mutationFn: () => downloadFailure(failure.id),
    onSuccess: (bytes) => save(failure.id, bytes),
  });
  const resend = useMutation({ mutationFn: () => resendFailure(failure.id), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => deleteFailure(failure.id), onSuccess: refresh });
  const isBusy = download.isPending || resend.isPending || remove.isPending;

  return (
    <TableRow>
      <TableCell className="data pl-4 text-muted-foreground">{when(failure.receivedAt)}</TableCell>
      <TableCell className="data">{failure.alias}</TableCell>
      <TableCell className="data max-w-56 truncate">
        {Option.getOrElse(failure.sender, () => "Unknown sender")}
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          <span>{REASONS[failure.reason]}</span>
          <Problem error={download.error ?? resend.error ?? remove.error} />
        </div>
      </TableCell>
      <TableCell>
        {failure.isKept ? (
          <Badge variant="secondary">Kept until {when(failure.expiresAt)}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">Until {when(failure.expiresAt)}</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1 pr-1">
          {failure.isKept && (
            <>
              <Button variant="ghost" size="sm" disabled={isBusy} onClick={() => download.mutate()}>
                <DownloadIcon />
                Download
              </Button>
              <Button variant="outline" size="sm" disabled={isBusy} onClick={() => resend.mutate()}>
                <RotateCwIcon />
                {resend.isPending ? "Sending…" : "Resend"}
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" disabled={isBusy} onClick={() => remove.mutate()}>
            <Trash2Icon />
            Delete
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
};

/**
 * Mail to the user's aliases that couldn't be forwarded for good (PLAN.md §20.33): SES refused
 * it, the destination is paused, its key no longer encrypts, or it was too large. Listed for 7
 * days; with "Keep failed mail" on in Settings, a sealed copy too, to download or send again.
 */
const FailedDeliveries = () => {
  const failures = useQuery(failuresQuery);
  return (
    <Page title="Failed deliveries">
      <p className="text-muted-foreground">
        Mail that couldn't be forwarded to your destination stays listed here for 7 days: when,
        which alias, who wrote and why, never the message itself. To download or resend such mail,
        turn on <span className="font-medium">Keep failed mail for 7 days</span> in{" "}
        <Link to="/settings" className="underline underline-offset-4">
          Settings
        </Link>
        ; the copy is kept encrypted and deleted after 7 days.
      </p>
      {failures.isError ? (
        <LoadFailed what="failed deliveries" onRetry={() => void failures.refetch()} />
      ) : failures.isSuccess && !Arr.isReadonlyArrayNonEmpty(failures.data) ? (
        <EmptyState icon={<MailWarningIcon />} title="Nothing failed">
          Every message to your aliases in the last 7 days was forwarded, kept or refused on
          purpose.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table aria-label="Failed deliveries" aria-busy={failures.isPending}>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="pl-2">Received</span>
                </TableHead>
                <TableHead>Alias</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Why</TableHead>
                <TableHead>Copy</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {failures.isPending ? (
                <SkeletonRows columns={6} />
              ) : (
                Arr.map(failures.data ?? [], (failure) => (
                  <FailureRow key={failure.id} failure={failure} />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  );
};

export const Route = createFileRoute("/_app/failed")({ component: FailedDeliveries });
