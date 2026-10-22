import type { SessionView } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import { MonitorSmartphoneIcon } from "lucide-react";
import { Problem } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { callSecurity, sessionsQuery } from "@/lib/security";

const when = (at: DateTime.Utc) => DateTime.format(at, { dateStyle: "medium", timeStyle: "short" });

const SessionRow = ({ session }: { readonly session: SessionView }) => {
  const queryClient = useQueryClient();
  const end = useMutation({
    mutationFn: () =>
      callSecurity((api) => api.security.endSession({ params: { sessionId: session.id } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionsQuery.queryKey }),
  });
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2 font-medium">
          <MonitorSmartphoneIcon className="size-4 text-muted-foreground" aria-hidden />
          Signed in {when(session.createdAt)}
          {session.isCurrent && <Badge variant="secondary">This browser</Badge>}
        </span>
        <span className="text-xs text-muted-foreground">Ends {when(session.expiresAt)}</span>
        <Problem error={end.error} />
      </div>
      {!session.isCurrent && (
        <Button variant="ghost" size="sm" disabled={end.isPending} onClick={() => end.mutate()}>
          Sign out
        </Button>
      )}
    </li>
  );
};

/** The account's browser sessions, each one ended on its own or all but this one at once. */
export const Sessions = () => {
  const queryClient = useQueryClient();
  const sessions = useQuery(sessionsQuery);
  const endOthers = useMutation({
    mutationFn: () => callSecurity((api) => api.security.endOtherSessions()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionsQuery.queryKey }),
  });
  if (sessions.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (sessions.isError) return <Problem error={sessions.error} />;
  const hasOthers = Arr.some(sessions.data, (session) => !session.isCurrent);
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {sessions.data.map((session) => (
          <SessionRow key={session.id} session={session} />
        ))}
      </ul>
      <Problem error={endOthers.error} />
      {hasOthers && (
        <Button
          variant="outline"
          className="self-start"
          disabled={endOthers.isPending}
          onClick={() => endOthers.mutate()}
        >
          Sign out everywhere else
        </Button>
      )}
    </div>
  );
};
