import type { BlocklistEntry } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as P from "effect/Predicate";
import { BanIcon, ShieldBanIcon } from "lucide-react";
import { Page } from "@/components/Page";
import { EmptyState, LoadFailed, Problem, SkeletonRows } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { blockSender, blocklistQuery, callRules } from "@/lib/rules";

const EntryRow = ({ entry }: { readonly entry: BlocklistEntry }) => {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => callRules((api) => api.blocklist.remove({ params: { entryId: entry.id } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: blocklistQuery.queryKey }),
  });
  return (
    <TableRow>
      <TableCell>
        <span className="data pl-2">{entry.id}</span>
      </TableCell>
      <TableCell>
        <Badge variant="secondary">
          {entry.kind === "address"
            ? "Address"
            : entry.isSubdomainIncluded
              ? "Domain and subdomains"
              : "Domain"}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Unblock ${entry.id}`}
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          Unblock
        </Button>
        <Problem error={remove.error} />
      </TableCell>
    </TableRow>
  );
};

const AddEntry = () => {
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: (form: FormData) => {
      const sender = form.get("sender");
      return blockSender(P.isString(sender) ? sender : "", form.get("subdomains") === "on");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: blocklistQuery.queryKey }),
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        add.mutate(new FormData(form), { onSuccess: () => form.reset() });
      }}
    >
      <Field>
        <FieldLabel htmlFor="blocked-sender">Sender</FieldLabel>
        <Input
          id="blocked-sender"
          name="sender"
          className="data"
          placeholder="news@shop.example or shop.example"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          required
        />
        <FieldDescription>
          An address blocks that sender; a domain blocks everyone at it.
        </FieldDescription>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="subdomains" />
        For a domain, block its subdomains too
      </label>
      <Button type="submit" disabled={add.isPending} className="self-start">
        <BanIcon />
        {add.isPending ? "Blocking…" : "Block sender"}
      </Button>
      <Problem error={add.error} />
    </form>
  );
};

/** Senders whose mail is dropped on every alias, counted as blocked (PLAN.md §20.32). */
const Blocklist = () => {
  const entries = useQuery(blocklistQuery);
  return (
    <Page title="Blocklist">
      <Card>
        <CardHeader>
          <CardTitle>Block a sender everywhere</CardTitle>
          <CardDescription>
            Mail from a blocked sender to any of your aliases is dropped and counted as blocked, and
            replies to them aren't sent. To block someone on one alias only, block the contact
            instead.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AddEntry />
        </CardContent>
      </Card>
      {entries.isError ? (
        <LoadFailed what="your blocklist" onRetry={() => void entries.refetch()} />
      ) : entries.isSuccess && !Arr.isReadonlyArrayNonEmpty(entries.data) ? (
        <EmptyState icon={<ShieldBanIcon />} title="Nobody is blocked">
          Block a sender above, or from an alias's contacts.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table aria-label="Blocked senders" aria-busy={entries.isPending}>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="pl-2">Sender</span>
                </TableHead>
                <TableHead>Blocks</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.isPending ? (
                <SkeletonRows columns={3} />
              ) : (
                Arr.map(entries.data, (entry) => <EntryRow key={entry.id} entry={entry} />)
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  );
};

export const Route = createFileRoute("/_app/blocklist")({ component: Blocklist });
