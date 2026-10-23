import type { AliasView } from "@alias/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as Struct from "effect/Struct";

import {
  AtSignIcon,
  CircleCheckIcon,
  DownloadIcon,
  FilterIcon,
  GlobeIcon,
  PlusIcon,
  SearchIcon,
  TagIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { AliasRow } from "@/components/aliases/AliasRow";
import { ComposeDialog } from "@/components/aliases/ComposeDialog";
import { ContactsSheet } from "@/components/aliases/ContactsSheet";
import { CreateAliasDialog } from "@/components/aliases/CreateAliasDialog";
import { DeleteAliasDialog } from "@/components/aliases/DeleteAliasDialog";
import { EditAliasDialog } from "@/components/aliases/EditAliasDialog";
import { ImportDialog } from "@/components/aliases/ImportDialog";
import { LabelsDialog } from "@/components/aliases/LabelsDialog";
import { OnTheFlySetting } from "@/components/aliases/OnTheFlySetting";
import { TrackerSettings } from "@/components/aliases/TrackerSettings";
import { Page } from "@/components/Page";
import { EmptyState, LoadFailed, Problem, SkeletonRows } from "@/components/states";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { aliasesQuery, domainsQuery, exportCsv, labelsQuery } from "@/lib/aliases";
import { usernamesQuery } from "@/lib/usernames";

/**
 * Everything on this screen that should survive a reload or be linkable lives in the URL: the
 * filters, the open dialog, the alias whose contacts show, the alias about to be deleted.
 */
const Search = Schema.Struct({
  q: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["active", "inactive"])),
  domain: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  dialog: Schema.optionalKey(Schema.Literals(["create", "labels", "import"])),
  contacts: Schema.optionalKey(Schema.String),
  edit: Schema.optionalKey(Schema.String),
  delete: Schema.optionalKey(Schema.String),
  /** The alias "Send mail" writes from, and the recipient it was opened for. */
  compose: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  /** Who the last mail went to, for the confirmation. */
  sent: Schema.optionalKey(Schema.String),
});
type Search = typeof Search.Type;

const ALL = "all";

/** The domain part of an address. */
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

/** The search box matches the address, the description and the labels. */
const matches = (q: string, alias: AliasView) =>
  Arr.some(
    Arr.appendAll([alias.address, Option.getOrElse(alias.description, () => "")], alias.labels),
    (text) => Str.includes(q)(Str.toLowerCase(text)),
  );

/**
 * `subdomains` are those of the username the filter names (PLAN.md §20.34); an alias matches when
 * it lives on one of them.
 */
const isShown = (search: Search, subdomains: ReadonlyArray<string>) => (alias: AliasView) =>
  matches(Str.toLowerCase(Str.trim(search.q ?? "")), alias) &&
  (search.status === undefined || alias.isActive === (search.status === "active")) &&
  (search.domain === undefined || domainOf(alias.address) === search.domain) &&
  (search.username === undefined || Arr.contains(subdomains, domainOf(alias.address))) &&
  (search.label === undefined || Arr.contains(alias.labels, search.label));

/** Hands the browser a file to save, from a click. */
const download = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};

const Aliases = () => {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const aliases = useQuery(aliasesQuery);
  const domains = useQuery(domainsQuery);
  const labels = useQuery(labelsQuery);
  const exporting = useMutation({
    mutationFn: exportCsv,
    onSuccess: (csv) => download("aliases.csv", csv),
  });
  const change = (next: (current: Search) => Search) =>
    void navigate({ search: next, replace: true });
  const without = (key: keyof Search) => change((current) => Struct.omit(current, [key]));
  const openCreate = () => change((current) => ({ ...current, dialog: "create" }));
  const openDialog = (dialog: "labels" | "import") => change((current) => ({ ...current, dialog }));
  const labelNames = Arr.dedupe(Arr.flatMap(aliases.data ?? [], (alias) => alias.labels));
  const allDomains = Arr.appendAll(domains.data?.shared ?? [], domains.data?.subdomains ?? []);
  const usernames = useQuery(usernamesQuery);
  const filtered = Option.flatMap(Option.fromUndefinedOr(search.username), (name) =>
    Arr.findFirst(usernames.data?.usernames ?? [], (entry) => entry.username === name),
  );
  const rows = Arr.filter(
    aliases.data ?? [],
    isShown(
      search,
      Option.match(filtered, { onNone: () => [], onSome: (entry) => entry.subdomains }),
    ),
  );
  const hasUsernames = Arr.length(usernames.data?.usernames ?? []) > 1;
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
          {hasUsernames && (
            <Select
              value={search.username ?? ALL}
              disabled={!hasAliases}
              onValueChange={(value) =>
                value === null || value === ALL
                  ? without("username")
                  : change((current) => ({ ...current, username: value }))
              }
            >
              <SelectTrigger aria-label="Filter by username">
                <AtSignIcon />
                <SelectValue>
                  {(value: string) => (value === ALL ? "All usernames" : value)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectItem value={ALL}>All usernames</SelectItem>
                <SelectSeparator />
                {Arr.map(usernames.data?.usernames ?? [], (entry) => (
                  <SelectItem key={entry.username} value={entry.username} className="data">
                    {entry.username}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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
          <Select
            value={search.label ?? ALL}
            disabled={!Arr.isReadonlyArrayNonEmpty(labelNames)}
            onValueChange={(value) =>
              value === null || value === ALL
                ? without("label")
                : change((current) => ({ ...current, label: value }))
            }
          >
            <SelectTrigger aria-label="Filter by label">
              <TagIcon />
              <SelectValue>{(value: string) => (value === ALL ? "All labels" : value)}</SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value={ALL}>All labels</SelectItem>
              <SelectSeparator />
              {Arr.map(labelNames, (label) => (
                <SelectItem key={label} value={label}>
                  {label}
                </SelectItem>
              ))}
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
          <Button variant="outline" onClick={() => openDialog("labels")}>
            <TagIcon />
            Labels
          </Button>
          <Button variant="outline" onClick={() => openDialog("import")}>
            <UploadIcon />
            Import
          </Button>
          <Button
            variant="outline"
            disabled={!hasAliases || exporting.isPending}
            onClick={() => exporting.mutate()}
          >
            <DownloadIcon />
            Export CSV
          </Button>
          <Button onClick={openCreate}>
            <PlusIcon />
            New alias
          </Button>
        </div>
      </div>
      <Problem error={exporting.error} />

      {search.sent !== undefined && (
        <Alert>
          <CircleCheckIcon />
          <AlertTitle>Sent</AlertTitle>
          <AlertDescription>
            Your mail to <span className="data">{search.sent}</span> left from the alias.
          </AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
              onClick={() => without("sent")}
            >
              <XIcon />
            </Button>
          </AlertAction>
        </Alert>
      )}
      {domains.isSuccess && <OnTheFlySetting subdomains={domains.data.subdomains} />}
      <TrackerSettings />

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
                        labels={labels.data ?? []}
                        onEdit={() => change((current) => ({ ...current, edit: alias.address }))}
                        onContacts={() =>
                          change((current) => ({ ...current, contacts: alias.address }))
                        }
                        onCompose={() =>
                          change((current) => ({
                            ...Struct.omit(current, ["to", "sent"]),
                            compose: alias.address,
                          }))
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
        onWrite={(aliasAddress, to) =>
          change((current) => ({
            ...Struct.omit(current, ["contacts", "sent"]),
            compose: aliasAddress,
            to,
          }))
        }
      />
      <ComposeDialog
        aliasAddress={Option.fromUndefinedOr(search.compose)}
        to={Option.fromUndefinedOr(search.to)}
        onClose={() => change((current) => Struct.omit(current, ["compose", "to"]))}
        onSent={(to) =>
          change((current) => ({ ...Struct.omit(current, ["compose", "to"]), sent: to }))
        }
      />
      <EditAliasDialog
        alias={Arr.findFirst(aliases.data ?? [], (alias) => alias.address === search.edit)}
        onClose={() => without("edit")}
      />
      <LabelsDialog isOpen={search.dialog === "labels"} onClose={() => without("dialog")} />
      <ImportDialog isOpen={search.dialog === "import"} onClose={() => without("dialog")} />
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
