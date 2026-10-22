import type { AliasView, Recipient } from "@alias/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as Num from "effect/Number";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import {
  ActivityIcon,
  AtSignIcon,
  FingerprintIcon,
  GlobeIcon,
  InboxIcon,
  PlusIcon,
  ReplyIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import type * as React from "react";
import { Page } from "@/components/Page";
import { LoadFailed } from "@/components/states";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { aliasesQuery, domainsQuery } from "@/lib/aliases";
import { recipientsQuery } from "@/lib/recipients";

/*
 * Only what the API counts today: per-alias totals since creation, and each destination's state.
 * There is no time series yet, so the design's daily chart and date range picker stay out.
 */

/** Series colours from the design; neutrals so they never read as a status. */
const shades = ["var(--chart-1)", "var(--chart-6)", "var(--chart-2)", "var(--chart-7)"] as const;
const otherShade = "var(--chart-5)";

interface Segment {
  readonly label: string;
  readonly count: number;
  readonly color: string;
}

const percent = (count: number, total: number) =>
  total === 0 ? "0%" : `${((count / total) * 100).toFixed(1)}%`;

/** A 10px stacked bar, the design's stand-in for a chart, with a row per segment below it. */
const SegmentList = ({ segments }: { readonly segments: ReadonlyArray<Segment> }) => {
  const total = Num.sumAll(Arr.map(segments, (segment) => segment.count));
  return (
    <div className="flex flex-1 flex-col gap-3 rounded-lg border bg-muted p-3">
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-sm" aria-hidden>
        {total === 0 ? (
          <div className="flex-1 bg-border" />
        ) : (
          Arr.map(segments, (segment) => (
            <div
              key={segment.label}
              style={{ flexGrow: segment.count, background: segment.color }}
            />
          ))
        )}
      </div>
      <ul className="flex flex-col gap-px bg-border">
        {Arr.map(segments, (segment) => (
          <li
            key={segment.label}
            className="grid grid-cols-[0.5rem_minmax(0,1fr)_3rem_3.5rem] items-center gap-2 bg-muted py-1.5"
          >
            <span className="size-2 rounded-xs" style={{ background: segment.color }} />
            <span className="data truncate">{segment.label}</span>
            <span className="data text-right">{segment.count}</span>
            <span className="data text-right text-muted-foreground">
              {percent(segment.count, total)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const byForwarded = Order.mapInput(
  Order.flip(Num.Order),
  (alias: AliasView) => alias.forwardedCount,
);

/** The four busiest aliases, and the rest summed up. */
const busiest = (aliases: ReadonlyArray<AliasView>): ReadonlyArray<Segment> => {
  const [top, rest] = Arr.splitAt(Arr.sort(aliases, byForwarded), 4);
  const shown = Arr.map(top, (alias, index) => ({
    label: alias.address,
    count: alias.forwardedCount,
    color: shades[index] ?? otherShade,
  }));
  return Arr.isReadonlyArrayNonEmpty(rest)
    ? Arr.append(shown, {
        label: `Other, ${Arr.length(rest)} aliases`,
        count: Num.sumAll(Arr.map(rest, (alias) => alias.forwardedCount)),
        color: otherShade,
      })
    : shown;
};

const CardHeading = ({
  icon,
  title,
  action,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly action?: React.ReactNode;
}) => (
  <CardHeader>
    <CardTitle className="flex items-center gap-2 text-sm [&_svg]:size-4 [&_svg]:text-muted-foreground">
      {icon}
      {title}
    </CardTitle>
    {action && (
      <CardAction>
        <span className="text-xs text-muted-foreground">{action}</span>
      </CardAction>
    )}
  </CardHeader>
);

const Fact = ({
  icon,
  title,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly children: React.ReactNode;
}) => (
  <div className="flex items-center gap-3 px-4 py-3 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
    {icon}
    <div className="flex flex-col gap-0.5">
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{children}</span>
    </div>
  </div>
);

/** Destinations that need the owner: bounced ones, or none verified at all. */
const DestinationAlerts = ({ recipients }: { readonly recipients: ReadonlyArray<Recipient> }) => {
  const bounced = Arr.filter(recipients, (recipient) => Option.isSome(recipient.bouncedAt));
  const hasVerified = Arr.some(recipients, (recipient) => recipient.isVerified);
  return (
    <>
      {!hasVerified && (
        <Alert>
          <TriangleAlertIcon className="text-warning" />
          <AlertTitle>No verified destination yet</AlertTitle>
          <AlertDescription>Your aliases have nowhere to forward mail to.</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="xs"
              nativeButton={false}
              render={<Link to="/destinations" search={{ dialog: "add" }} />}
            >
              Add destination
            </Button>
          </AlertAction>
        </Alert>
      )}
      {Arr.map(bounced, (recipient) => (
        <Alert key={recipient.id}>
          <TriangleAlertIcon className="text-warning" />
          <AlertTitle>
            <span className="data">{recipient.address}</span> bounced
          </AlertTitle>
          <AlertDescription>Nothing is forwarded there until you retry it.</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="xs"
              nativeButton={false}
              render={<Link to="/destinations" />}
            >
              View
            </Button>
          </AlertAction>
        </Alert>
      ))}
    </>
  );
};

const DestinationsCard = ({ recipients }: { readonly recipients: ReadonlyArray<Recipient> }) => (
  <Card>
    <CardHeading
      icon={<InboxIcon />}
      title="Destinations"
      action={
        <>
          <span className="data">{Arr.length(recipients)}</span> mailboxes
        </>
      }
    />
    <CardContent className="flex flex-1 flex-col">
      <ul className="flex flex-col gap-px overflow-hidden rounded-lg border bg-border">
        {Arr.match(recipients, {
          onEmpty: () => (
            <li className="bg-muted p-3 text-muted-foreground">No destinations yet.</li>
          ),
          onNonEmpty: (rows) =>
            Arr.map(rows, (recipient) => (
              <li key={recipient.id} className="flex items-center gap-2 bg-muted px-3 py-2">
                <span className="data min-w-0 flex-1 truncate">{recipient.address}</span>
                {recipient.isDefault && <Badge variant="outline">Default</Badge>}
                {Option.isSome(recipient.bouncedAt) ? (
                  <Badge variant="destructive">Bounced</Badge>
                ) : recipient.isVerified ? (
                  <Badge variant="success">Verified</Badge>
                ) : (
                  <Badge variant="warning">Pending</Badge>
                )}
              </li>
            )),
        })}
      </ul>
    </CardContent>
  </Card>
);

const Overview = () => {
  const aliases = useQuery(aliasesQuery);
  const recipients = useQuery(recipientsQuery);
  const domains = useQuery(domainsQuery);

  if (aliases.isError || recipients.isError) {
    return (
      <Page title="Overview">
        <LoadFailed
          what="your overview"
          onRetry={() => {
            void aliases.refetch();
            void recipients.refetch();
          }}
        />
      </Page>
    );
  }
  if (aliases.isPending || recipients.isPending) {
    return (
      <Page title="Overview">
        <div className="flex flex-col gap-4" aria-busy>
          <Skeleton className="h-5 w-96 max-w-full" />
          <Skeleton className="h-16 w-full" />
          <div className="grid gap-4 lg:grid-cols-3">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        </div>
      </Page>
    );
  }

  const forwarded = Num.sumAll(Arr.map(aliases.data, (alias) => alias.forwardedCount));
  const blocked = Num.sumAll(Arr.map(aliases.data, (alias) => alias.blockedCount));
  const allDomains = Arr.appendAll(domains.data?.shared ?? [], domains.data?.subdomains ?? []);

  return (
    <Page title="Overview">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Your mail so far</h2>
        <p className="text-muted-foreground">
          <span className="data text-foreground">{forwarded}</span> forwarded,{" "}
          <span className="data text-foreground">{blocked}</span> blocked, across{" "}
          <span className="data text-foreground">{Arr.length(aliases.data)}</span> aliases since you
          created them.
        </p>
      </div>

      <DestinationAlerts recipients={recipients.data} />

      <div className="grid rounded-lg border md:grid-cols-3 md:divide-x">
        <Fact icon={<ShieldCheckIcon />} title="Verified destinations only">
          Unconfirmed mailboxes never receive mail
        </Fact>
        <Fact icon={<ReplyIcon />} title="Replies through reverse aliases">
          Senders never see your real address
        </Fact>
        <Fact icon={<FingerprintIcon />} title="Passkey sign-in">
          No password to phish or leak
        </Fact>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeading
            icon={<AtSignIcon />}
            title="Forwarded by alias"
            action={
              <>
                <span className="data">{forwarded}</span> total
              </>
            }
          />
          <CardContent className="flex flex-1 flex-col">
            {Arr.isReadonlyArrayNonEmpty(aliases.data) ? (
              <SegmentList segments={busiest(aliases.data)} />
            ) : (
              <p className="rounded-lg border bg-muted p-3 text-muted-foreground">
                No aliases yet.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeading
            icon={<ActivityIcon />}
            title="Delivery outcomes"
            action={
              <>
                <span className="data">{forwarded + blocked}</span> messages
              </>
            }
          />
          <CardContent className="flex flex-1 flex-col">
            <SegmentList
              segments={[
                { label: "Forwarded", count: forwarded, color: "var(--chart-1)" },
                { label: "Blocked", count: blocked, color: "var(--chart-4)" },
              ]}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Blocked: spam, viruses, loops, blocked contacts, hourly caps and inactive aliases.
            </p>
          </CardContent>
        </Card>
        <DestinationsCard recipients={recipients.data} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card>
          <CardHeading icon={<ZapIcon />} title="Quick actions" />
          <CardContent>
            <div className="flex flex-col gap-2 rounded-lg border bg-muted p-3">
              <Button
                className="justify-start"
                nativeButton={false}
                render={<Link to="/aliases" search={{ dialog: "create" }} />}
              >
                <PlusIcon />
                New alias
              </Button>
              <Button
                variant="outline"
                className="justify-start"
                nativeButton={false}
                render={<Link to="/destinations" search={{ dialog: "add" }} />}
              >
                <InboxIcon />
                Add destination
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeading icon={<GlobeIcon />} title="Your domains" />
          <CardContent>
            <ul className="flex flex-col rounded-lg border bg-muted px-3 py-1">
              {Arr.map(allDomains, (domain) => (
                <li
                  key={domain}
                  className="flex items-center justify-between gap-2 border-b py-2 last:border-b-0"
                >
                  <span className="data truncate">{domain}</span>
                  <span className="text-xs text-muted-foreground">
                    <span className="data">
                      {Arr.length(
                        Arr.filter(aliases.data, (alias) =>
                          Str.endsWith(`@${domain}`)(alias.address),
                        ),
                      )}
                    </span>{" "}
                    aliases
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
};

export const Route = createFileRoute("/_app/")({ component: Overview });
