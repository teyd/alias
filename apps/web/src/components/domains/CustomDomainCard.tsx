import type { Domain } from "@alias/contracts";
import { DomainSetup } from "@alias/dns";
import { useMutation } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { ChevronRightIcon, DownloadIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { Problem } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type DomainRecord, checkDomain, setCatchAll } from "@/lib/domains";
import { useRefreshDomains } from "./refresh";

type BadgeVariant = "success" | "warning" | "destructive" | "secondary" | "outline";

const status: Record<Domain["status"], { readonly label: string; readonly variant: BadgeVariant }> =
  {
    pending: { label: "Pending", variant: "warning" },
    verified: { label: "Verified", variant: "success" },
    failed: { label: "Records missing", variant: "destructive" },
  };

const purpose: Record<DomainRecord["purpose"], string> = {
  ownership: "Proves the domain is yours",
  receiving: "Delivers its mail to us",
  dkim: "Signs mail sent from it (DKIM)",
  "mail-from": "Bounces and SPF (MAIL FROM)",
  dmarc: "Policy for failing mail (DMARC)",
};

const state: Record<
  DomainRecord["state"],
  { readonly label: string; readonly variant: BadgeVariant }
> = {
  ok: { label: "Found", variant: "success" },
  missing: { label: "Not found", variant: "destructive" },
  wrong: { label: "Different value", variant: "destructive" },
  unknown: { label: "Lookup failed", variant: "secondary" },
  unchecked: { label: "Not checked", variant: "outline" },
};

const when = (at: DateTime.Utc) => DateTime.format(at, { dateStyle: "medium", timeStyle: "short" });

/** One record as DNS providers' forms ask for it, each part copyable. */
const RecordRow = ({ record }: { readonly record: DomainRecord }) => (
  <TableRow>
    <TableCell>
      <div className="flex flex-col gap-0.5 pl-1">
        <span>{purpose[record.purpose]}</span>
        <span className="text-xs text-muted-foreground">
          {record.isRequired ? "Required" : "Recommended"}
        </span>
      </div>
    </TableCell>
    <TableCell className="data">{record.type}</TableCell>
    <TableCell>
      <div className="flex items-center gap-1">
        <span className="data break-all">{record.name}</span>
        <CopyButton text={record.name} label={`Copy name of the ${record.type} record`} />
      </div>
    </TableCell>
    <TableCell>
      <div className="flex items-center gap-1">
        <span className="data break-all">
          {P.isNumber(record.priority) && (
            <span className="text-muted-foreground">{record.priority} </span>
          )}
          {record.value}
        </span>
        <CopyButton text={record.value} label={`Copy value of the ${record.type} record`} />
      </div>
    </TableCell>
    <TableCell className="text-right">
      <span className="pr-1">
        <Badge
          variant={
            // A missing recommended record costs deliverability, not the domain.
            !record.isRequired && state[record.state].variant === "destructive"
              ? "warning"
              : state[record.state].variant
          }
        >
          {state[record.state].label}
        </Badge>
      </span>
    </TableCell>
  </TableRow>
);

/** The records as DNS providers' forms ask for them, with what the last check found. */
const RecordTable = ({
  label,
  records,
}: {
  readonly label: string;
  readonly records: ReadonlyArray<DomainRecord>;
}) => (
  <div className="overflow-x-auto rounded-lg border bg-muted">
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead>
            <span className="pl-1">Record</span>
          </TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Value</TableHead>
          <TableHead className="text-right">
            <span className="pr-1">Status</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Arr.map(records, (record) => (
          <RecordRow key={`${record.type} ${record.name} ${record.value}`} record={record} />
        ))}
      </TableBody>
    </Table>
  </div>
);

/** Hands every record to the browser as a BIND zone file, for the DNS provider's import. */
const download = (domain: Domain) => {
  const url = URL.createObjectURL(
    new Blob([DomainSetup.zoneFile(domain.domain, domain.records)], { type: "text/plain" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${domain.domain}.zone`;
  link.click();
  URL.revokeObjectURL(url);
};

/**
 * A custom domain: its status, the DNS records to publish with what the last check found (the
 * required ones up front, the recommended ones folded away), the zone file, a check on demand, the
 * catch-all switch and removal.
 */
export const CustomDomainCard = ({
  domain,
  onRemove,
}: {
  readonly domain: Domain;
  readonly onRemove: () => void;
}) => {
  const refresh = useRefreshDomains();
  const check = useMutation({
    mutationFn: () => checkDomain(domain.domain),
    onSuccess: () => refresh(),
  });
  const catchAll = useMutation({
    mutationFn: (isEnabled: boolean) => setCatchAll(domain.domain, isEnabled),
    onSuccess: () => refresh(),
  });
  const catchAllId = `catch-all-${domain.domain}`;
  const required = Arr.filter(domain.records, (record) => record.isRequired);
  const recommended = Arr.filter(domain.records, (record) => !record.isRequired);
  // A recommended record that is there but wrong needs fixing, so it isn't left folded away; the
  // key opens the section again when a check finds one.
  const isRecommendedWrong = Arr.some(recommended, (record) => record.state === "wrong");

  return (
    <Card aria-label={domain.domain}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="data">{domain.domain}</span>
          <Badge variant={status[domain.status].variant}>{status[domain.status].label}</Badge>
        </CardTitle>
        <CardDescription>
          {domain.status === "verified"
            ? "Aliases on it receive mail, and replies go out from it."
            : domain.status === "failed"
              ? "A required record is missing or changed, so its aliases are paused. They resume by themselves once it's back."
              : `Publish these ${required.length} records at your DNS provider. We check every ten minutes; DNS changes can take a while to show.`}{" "}
          {Option.match(domain.checkedAt, {
            onNone: () => "Not checked yet.",
            onSome: (at) => `Last checked ${when(at)}.`,
          })}{" "}
          {Option.match(domain.expiresAt, {
            onNone: () => "",
            onSome: (at) => `Released on ${when(at)} unless verified by then.`,
          })}
        </CardDescription>
        <CardAction className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            <RefreshCwIcon />
            {check.isPending ? "Checking…" : "Check now"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove ${domain.domain}`}
            onClick={onRemove}
          >
            <Trash2Icon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <RecordTable label={`Required DNS records for ${domain.domain}`} records={required} />
        <Collapsible
          key={isRecommendedWrong ? "wrong" : "fine"}
          defaultOpen={isRecommendedWrong}
          className="flex flex-col gap-2"
        >
          <CollapsibleTrigger
            render={
              <Button variant="ghost" size="sm" className="group self-start">
                <ChevronRightIcon className="transition-transform group-aria-expanded:rotate-90" />
                Optional: better deliverability ({recommended.length} records)
              </Button>
            }
          />
          <CollapsibleContent className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              MAIL FROM and SPF let bounces come back to your domain and make SPF pass for it; DMARC
              tells receivers what to do with mail that fails those checks. Mail works without them,
              but lands in spam more often.
            </p>
            <RecordTable
              label={`Recommended DNS records for ${domain.domain}`}
              records={recommended}
            />
          </CollapsibleContent>
        </Collapsible>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button variant="outline" size="sm" onClick={() => download(domain)}>
            <DownloadIcon />
            Download zone file
          </Button>
          <span className="text-xs text-muted-foreground">
            Cloudflare: DNS → Records → Import and Export → Import
          </span>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="flex flex-col gap-0.5">
            <span id={`${catchAllId}-label`} className="font-medium">
              Catch-all
            </span>
            <span id={`${catchAllId}-description`} className="text-xs text-muted-foreground">
              Mail to any new address on <span className="data">{domain.domain}</span> creates that
              alias and is forwarded. Off, it is dropped until you create the alias.
            </span>
          </div>
          <Switch
            aria-labelledby={`${catchAllId}-label`}
            aria-describedby={`${catchAllId}-description`}
            aria-busy={catchAll.isPending}
            checked={domain.isCatchAllEnabled}
            disabled={catchAll.isPending}
            onCheckedChange={(isEnabled) => catchAll.mutate(isEnabled)}
          />
        </div>
        <Problem error={check.error ?? catchAll.error} />
      </CardContent>
    </Card>
  );
};
