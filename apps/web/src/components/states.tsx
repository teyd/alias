import type { UseQueryResult } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { CircleXIcon, RefreshCwIcon } from "lucide-react";
import type * as React from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";

/** The message of a failed query or mutation, if there is one. */
export const Problem = ({ error }: Pick<UseQueryResult, "error">) =>
  Option.match(Option.fromNullOr(error), {
    onNone: () => null,
    onSome: (present) => (
      <p role="alert" className="text-sm text-destructive">
        {present.message}
      </p>
    ),
  });

/** A list that couldn't load, with a way to try again. */
export const LoadFailed = ({
  what,
  onRetry,
}: {
  readonly what: string;
  readonly onRetry: () => void;
}) => (
  <Alert variant="destructive">
    <CircleXIcon />
    <AlertTitle>Couldn't load {what}</AlertTitle>
    <AlertDescription>Check your connection, then try again.</AlertDescription>
    <AlertAction>
      <Button variant="outline" size="xs" onClick={onRetry}>
        <RefreshCwIcon />
        Retry
      </Button>
    </AlertAction>
  </Alert>
);

/** The design's empty state: an icon tile, a title, one sentence and the next step. */
export const EmptyState = ({
  icon,
  title,
  children,
  action,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly children: React.ReactNode;
  readonly action?: React.ReactNode;
}) => (
  <div className="flex flex-col items-center justify-center gap-3 rounded-lg border bg-card px-6 py-24 text-center">
    <div className="flex size-8 items-center justify-center rounded-lg border bg-muted text-muted-foreground [&_svg]:size-4">
      {icon}
    </div>
    <div className="flex flex-col gap-1">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-muted-foreground">{children}</p>
    </div>
    {action}
  </div>
);

/** Placeholder rows while a table loads. */
export const SkeletonRows = ({ columns }: { readonly columns: number }) =>
  Arr.map(Arr.range(1, 3), (row) => (
    <TableRow key={row} aria-hidden>
      {Arr.map(Arr.range(1, columns), (column) => (
        <TableCell key={column}>
          <Skeleton className="h-4 w-full max-w-40" />
        </TableCell>
      ))}
    </TableRow>
  ));
