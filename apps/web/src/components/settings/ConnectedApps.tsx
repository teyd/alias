import type { ConnectedApp } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import { PlugIcon } from "lucide-react";
import { Problem } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { callOAuth, grantsQuery } from "@/lib/oauth";

const AppRow = ({ app }: { readonly app: ConnectedApp }) => {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => callOAuth((api) => api.consent.revoke({ params: { grantId: app.id } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: grantsQuery.queryKey }),
  });
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2 font-medium">
          <PlugIcon className="size-4 text-muted-foreground" aria-hidden />
          {app.clientName}
        </span>
        <span className="flex flex-wrap gap-1">
          {app.scopes.map((scope) => (
            <Badge key={scope} variant="secondary" className="data">
              {scope}
            </Badge>
          ))}
        </span>
        <span className="data truncate text-xs text-muted-foreground">{app.clientId}</span>
        <span className="text-xs text-muted-foreground">
          Connected {DateTime.format(app.createdAt, { dateStyle: "medium" })}
        </span>
        <Problem error={revoke.error} />
      </div>
      <Button variant="ghost" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
        Disconnect
      </Button>
    </li>
  );
};

/** MCP clients the user approved through OAuth, each with its own grant to disconnect. */
export const ConnectedApps = () => {
  const apps = useQuery(grantsQuery);
  if (apps.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (apps.isError) return <Problem error={apps.error} />;
  return Arr.match(apps.data, {
    onEmpty: () => <p className="text-sm text-muted-foreground">No apps connected.</p>,
    onNonEmpty: (rows) => (
      <ul className="flex flex-col gap-2">
        {rows.map((app) => (
          <AppRow key={app.id} app={app} />
        ))}
      </ul>
    ),
  });
};
