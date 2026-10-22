import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { FingerprintIcon } from "lucide-react";
import type * as React from "react";
import { CopyButton } from "@/components/CopyButton";
import { Page } from "@/components/Page";
import { Separator } from "@/components/ui/separator";
import { domainsQuery } from "@/lib/aliases";
import { meQuery } from "@/lib/session";

/** One settings group: a heading with its explanation, then its rows. */
const Section = ({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: React.ReactNode;
}) => (
  <section className="flex flex-col gap-4 py-6 first:pt-0" aria-label={title}>
    <div className="flex flex-col gap-0.5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
    {children}
  </section>
);

const Settings = () => {
  const me = useQuery(meQuery);
  const domains = useQuery(domainsQuery);
  return (
    <Page title="Settings">
      <div className="mx-auto flex w-full max-w-3xl flex-col">
        {Option.match(me.data ?? Option.none(), {
          onNone: () => null,
          onSome: (user) => (
            <Section
              title="Account"
              description="Your username names your subdomain, so it shows in every alias you create there."
            >
              <dl className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] items-center gap-x-4 gap-y-3">
                <dt className="text-muted-foreground">Username</dt>
                <dd className="data">{user.username}</dd>
                <dt className="text-muted-foreground">Subdomain</dt>
                <dd className="data">
                  {Option.getOrElse(Arr.head(domains.data?.subdomains ?? []), () => "–")}
                </dd>
                <dt className="text-muted-foreground">Account ID</dt>
                <dd className="flex items-center gap-1">
                  <span className="data truncate">{user.userId}</span>
                  <CopyButton text={user.userId} label="Copy account ID" />
                </dd>
              </dl>
            </Section>
          ),
        })}
        <Separator />
        <Section
          title="Sign-in"
          description="Passkeys are bound to this site, so they can't be phished."
        >
          <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
            <FingerprintIcon className="size-4 text-muted-foreground" aria-hidden />
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">Passkey</span>
              <span className="text-xs text-muted-foreground">
                The one you created at sign-up. There is no password to steal or reset.
              </span>
            </div>
          </div>
        </Section>
      </div>
    </Page>
  );
};

export const Route = createFileRoute("/_app/settings")({ component: Settings });
