import type { AliasView } from "@alias/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { GlobeIcon, ServerIcon } from "lucide-react";
import { Page } from "@/components/Page";
import { LoadFailed, SkeletonRows } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { aliasesQuery, domainsQuery } from "@/lib/aliases";

/**
 * A domain the user can create aliases on. Custom domains (PLAN.md §20.18) add a third kind,
 * with their verification state, to the same table.
 */
interface DomainRow {
  readonly name: string;
  readonly kind: "shared" | "subdomain";
}

const kinds = {
  shared: { label: "Shared", addresses: "Random addresses only" },
  subdomain: { label: "Your subdomain", addresses: "Any address you pick" },
} as const;

const aliasCount = (aliases: ReadonlyArray<AliasView>, domain: string) =>
  Arr.length(Arr.filter(aliases, (alias) => Str.endsWith(`@${domain}`)(alias.address)));

const DomainsTable = ({ rows }: { readonly rows: ReadonlyArray<DomainRow> }) => {
  const aliases = useQuery(aliasesQuery);
  return (
    <div className="overflow-hidden rounded-lg border bg-muted">
      <Table aria-label="Domains">
        <TableHeader>
          <TableRow>
            <TableHead>
              <span className="pl-1">Domain</span>
            </TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Addresses</TableHead>
            <TableHead className="text-right">
              <span className="pr-1">Aliases</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Arr.map(rows, (row) => (
            <TableRow key={row.name}>
              <TableCell>
                <span className="data pl-1">{row.name}</span>
              </TableCell>
              <TableCell>
                <Badge variant={row.kind === "subdomain" ? "outline" : "secondary"}>
                  {kinds[row.kind].label}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{kinds[row.kind].addresses}</TableCell>
              <TableCell className="data text-right">
                <span className="pr-1">
                  {aliases.isSuccess ? aliasCount(aliases.data, row.name) : "–"}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

const Domains = () => {
  const domains = useQuery(domainsQuery);
  return (
    <Page title="Domains">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GlobeIcon className="size-4 text-muted-foreground" aria-hidden />
            Domains you can use
          </CardTitle>
          <CardDescription>
            Shared domains give out random addresses, so they can't be guessed. On your own
            subdomain you pick the address.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {domains.isError ? (
            <LoadFailed what="your domains" onRetry={() => void domains.refetch()} />
          ) : domains.isPending ? (
            <Table aria-busy>
              <TableBody>
                <SkeletonRows columns={4} />
              </TableBody>
            </Table>
          ) : (
            <DomainsTable
              rows={Arr.appendAll(
                Arr.map(domains.data.shared, (name): DomainRow => ({ name, kind: "shared" })),
                Arr.map(domains.data.subdomains, (name): DomainRow => ({
                  name,
                  kind: "subdomain",
                })),
              )}
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ServerIcon className="size-4 text-muted-foreground" aria-hidden />
            Custom domains
          </CardTitle>
          <CardDescription>
            Bringing your own domain isn't available yet. When it is, you'll add it here and follow
            the DNS steps.
          </CardDescription>
        </CardHeader>
      </Card>
    </Page>
  );
};

export const Route = createFileRoute("/_app/domains")({ component: Domains });
