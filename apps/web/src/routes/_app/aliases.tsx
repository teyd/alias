import type { AliasView } from "@alias/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as Struct from "effect/Struct";
import { AtSignIcon, FilterIcon, GlobeIcon, PlusIcon, SearchIcon } from "lucide-react";
import { AliasRow } from "@/components/aliases/AliasRow";
import { ContactsSheet } from "@/components/aliases/ContactsSheet";
import { CreateAliasDialog } from "@/components/aliases/CreateAliasDialog";
import { DeleteAliasDialog } from "@/components/aliases/DeleteAliasDialog";
import { OnTheFlySetting } from "@/components/aliases/OnTheFlySetting";
import { Page } from "@/components/Page";
import { EmptyState, LoadFailed, SkeletonRows } from "@/components/states";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
 * Everything on this screen that should survive a reload or be linkable lives in the URL: the
 * filters, the open dialog, the alias whose contacts show, the alias about to be deleted.
 */
const Search = Schema.Struct({
  q: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["active", "inactive"])),
  domain: Schema.optionalKey(Schema.String),
  dialog: Schema.optionalKey(Schema.Literal("create")),
  contacts: Schema.optionalKey(Schema.String),
  delete: Schema.optionalKey(Schema.String),
});
type Search = typeof Search.Type;

const ALL = "all";

const isShown = (search: Search) => (alias: AliasView) =>
  Str.includes(Str.toLowerCase(Str.trim(search.q ?? "")))(alias.address) &&
  (search.status === undefined || alias.isActive === (search.status === "active")) &&
  (search.domain === undefined || Str.endsWith(`@${search.domain}`)(alias.address));

const Aliases = () => {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const aliases = useQuery(aliasesQuery);
  const domains = useQuery(domainsQuery);
  const change = (next: (current: Search) => Search) =>
    void navigate({ search: next, replace: true });
  const without = (key: keyof Search) => change((current) => Struct.omit(current, [key]));
  const openCreate = () => change((current) => ({ ...current, dialog: "create" }));
  const allDomains = Arr.appendAll(domains.data?.shared ?? [], domains.data?.subdomains ?? []);
  const rows = Arr.filter(aliases.data ?? [], isShown(search));
  const inactive = Arr.length(Arr.filter(aliases.data ?? [], (alias) => !alias.isActive));
  const hasAliases = Arr.isReadonlyArrayNonEmpty(aliases.data ?? []);

  return (
    <Page title="Aliases">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="w-72">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label="Search aliases"
              placeholder="Search aliases"
              value={search.q ?? ""}
              disabled={!hasAliases}
              onChange={(event) => {
                const q = event.target.value;
                change((current) =>
                  Str.isEmpty(q) ? Struct.omit(current, ["q"]) : { ...current, q },
                );
              }}
            />
          </InputGroup>
          <Select
            value={search.domain ?? ALL}
            disabled={!hasAliases}
            onValueChange={(value) =>
              value === null || value === ALL
                ? without("domain")
                : change((current) => ({ ...current, domain: value }))
            }
          >
            <SelectTrigger aria-label="Filter by domain">
              <GlobeIcon />
              <SelectValue>
                {(value: string) => (value === ALL ? "All domains" : value)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value={ALL}>All domains</SelectItem>
              <SelectSeparator />
              {Arr.map(allDomains, (domain) => (
                <SelectItem key={domain} value={domain} className="data">
                  {domain}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={search.status ?? ALL}
            disabled={!hasAliases}
            onValueChange={(value) =>
              value === "active" || value === "inactive"
                ? change((current) => ({ ...current, status: value }))
                : without("status")
            }
          >
            <SelectTrigger aria-label="Filter by status">
              <FilterIcon />
              <SelectValue>
                {(value: string) =>
                  value === "active" ? "Active" : value === "inactive" ? "Inactive" : "All statuses"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value={ALL}>All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-4">
          {aliases.isSuccess && (
            <span className="text-xs text-muted-foreground">
              <span className="data">{Arr.length(aliases.data)}</span> aliases,{" "}
              <span className="data">{inactive}</span> inactive
            </span>
          )}
          <Button onClick={openCreate}>
            <PlusIcon />
            New alias
          </Button>
        </div>
      </div>

      {domains.isSuccess && <OnTheFlySetting subdomains={domains.data.subdomains} />}

      {aliases.isError ? (
        <LoadFailed what="your aliases" onRetry={() => void aliases.refetch()} />
      ) : aliases.isSuccess && !hasAliases ? (
        <EmptyState
          icon={<AtSignIcon />}
          title="No aliases yet"
          action={
            <Button onClick={openCreate}>
              <PlusIcon />
              New alias
            </Button>
          }
        >
          Create an alias to get an address that forwards to your mailbox without revealing it.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table aria-label="Aliases" aria-busy={aliases.isPending}>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="pl-2">Alias</span>
                </TableHead>
                <TableHead className="text-right">Forwarded</TableHead>
                <TableHead className="text-right">Blocked</TableHead>
                <TableHead>
                  <span className="sr-only">Contacts</span>
                </TableHead>
                <TableHead>Active</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {aliases.isPending ? (
                <SkeletonRows columns={6} />
              ) : (
                Arr.match(rows, {
                  onEmpty: () => (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                        No aliases match these filters.
                      </TableCell>
                    </TableRow>
                  ),
                  onNonEmpty: (shown) =>
                    Arr.map(shown, (alias) => (
                      <AliasRow
                        key={alias.id}
                        alias={alias}
                        onContacts={() =>
                          change((current) => ({ ...current, contacts: alias.address }))
                        }
                        onDelete={() =>
                          change((current) => ({ ...current, delete: alias.address }))
                        }
                      />
                    )),
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Counters are totals since each alias was created. Replies leave through each contact's
        reverse alias; your mailbox is never shown to senders.
      </p>

      <CreateAliasDialog
        isOpen={search.dialog === "create"}
        onOpenChange={(isOpen) => (isOpen ? openCreate() : without("dialog"))}
      />
      <ContactsSheet
        aliasAddress={Option.fromUndefinedOr(search.contacts)}
        onClose={() => without("contacts")}
      />
      <DeleteAliasDialog
        aliasAddress={Option.fromUndefinedOr(search.delete)}
        onClose={() => without("delete")}
      />
    </Page>
  );
};

export const Route = createFileRoute("/_app/aliases")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  component: Aliases,
});
