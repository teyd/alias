import type { AliasView, Domain } from "@alias/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as Struct from "effect/Struct";
import { GlobeIcon, PlusIcon, ServerIcon } from "lucide-react";
import { AddDomainDialog } from "@/components/domains/AddDomainDialog";
import { CustomDomainCard } from "@/components/domains/CustomDomainCard";
import { RemoveDomainDialog } from "@/components/domains/RemoveDomainDialog";
import { Page } from "@/components/Page";
import { AddUsernameDialog } from "@/components/usernames/AddUsernameDialog";
import { DeleteUsernameDialog } from "@/components/usernames/DeleteUsernameDialog";
import { UsernamesCard } from "@/components/usernames/UsernamesCard";
import { EmptyState, LoadFailed, SkeletonRows } from "@/components/states";
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
import { Button } from "@/components/ui/button";
import { aliasesQuery, domainsQuery } from "@/lib/aliases";
import { customDomainsQuery } from "@/lib/domains";

/**
 * `?dialog=add-domain` and `?dialog=add-username` hold the add dialogs open, `?remove=<domain>`
 * and `?deleteUsername=<username>` the removal ones.
 */
const Search = Schema.Struct({
  dialog: Schema.optionalKey(Schema.Literals(["add-domain", "add-username"])),
  remove: Schema.optionalKey(Schema.String),
  deleteUsername: Schema.optionalKey(Schema.String),
});

/** A domain the user can create aliases on: shared, their subdomain, or a custom domain. */
interface DomainRow {
  readonly name: string;
  readonly kind: "shared" | "subdomain" | "custom";
}

const kinds = {
  shared: { label: "Shared", addresses: "Random addresses only" },
  subdomain: { label: "Your subdomain", addresses: "Any address you pick" },
  custom: { label: "Custom", addresses: "Any address you pick" },
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
                <Badge variant={row.kind === "shared" ? "secondary" : "outline"}>
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

/** The user's custom domains, each with its DNS records, or the first step to add one. */
const CustomDomains = ({
  onAdd,
  onRemove,
}: {
  readonly onAdd: () => void;
  readonly onRemove: (domain: string) => void;
}) => {
  const domains = useQuery(customDomainsQuery);
  if (domains.isError) {
    return <LoadFailed what="your custom domains" onRetry={() => void domains.refetch()} />;
  }
  if (domains.isPending) return null;
  return Arr.match(domains.data, {
    onEmpty: () => (
      <EmptyState
        icon={<ServerIcon />}
        title="No custom domains yet"
        action={
          <Button onClick={onAdd}>
            <PlusIcon />
            Add domain
          </Button>
        }
      >
        Use your own domain for aliases (anything@yourdomain.com): add it, publish the DNS records
        we list, and check.
      </EmptyState>
    ),
    onNonEmpty: (rows) =>
      Arr.map(rows, (domain: Domain) => (
        <CustomDomainCard
          key={domain.domain}
          domain={domain}
          onRemove={() => onRemove(domain.domain)}
        />
      )),
  });
};

const Domains = () => {
  const domains = useQuery(domainsQuery);
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const change = (update: (current: typeof Search.Type) => typeof Search.Type) =>
    void navigate({ search: update, replace: true });
  const openAdd = () => change((current) => ({ ...current, dialog: "add-domain" }));

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
            subdomains and your verified custom domains you pick the address.
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
              rows={[
                ...Arr.map(domains.data.shared, (name): DomainRow => ({ name, kind: "shared" })),
                ...Arr.map(domains.data.subdomains, (name): DomainRow => ({
                  name,
                  kind: "subdomain",
                })),
                ...Arr.map(domains.data.custom, (name): DomainRow => ({ name, kind: "custom" })),
              ]}
            />
          )}
        </CardContent>
      </Card>
      <UsernamesCard
        onAdd={() => change((current) => ({ ...current, dialog: "add-username" }))}
        onDelete={(username) => change((current) => ({ ...current, deleteUsername: username }))}
      />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ServerIcon className="size-4 text-muted-foreground" aria-hidden />
          Custom domains
        </h2>
        <Button variant="outline" onClick={openAdd}>
          <PlusIcon />
          Add domain
        </Button>
      </div>
      <CustomDomains
        onAdd={openAdd}
        onRemove={(domain) => change((current) => ({ ...current, remove: domain }))}
      />
      <AddDomainDialog
        isOpen={search.dialog === "add-domain"}
        onOpenChange={(isOpen) =>
          isOpen ? openAdd() : change((current) => Struct.omit(current, ["dialog"]))
        }
      />
      <AddUsernameDialog
        isOpen={search.dialog === "add-username"}
        onOpenChange={(isOpen) =>
          isOpen
            ? change((current) => ({ ...current, dialog: "add-username" }))
            : change((current) => Struct.omit(current, ["dialog"]))
        }
      />
      <DeleteUsernameDialog
        username={Option.fromUndefinedOr(search.deleteUsername)}
        onClose={() => change((current) => Struct.omit(current, ["deleteUsername"]))}
      />
      <RemoveDomainDialog
        domain={Option.fromUndefinedOr(search.remove)}
        onClose={() => change((current) => Struct.omit(current, ["remove"]))}
      />
    </Page>
  );
};

export const Route = createFileRoute("/_app/domains")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  component: Domains,
});
