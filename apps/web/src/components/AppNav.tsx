import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  AtSignIcon,
  GlobeIcon,
  InboxIcon,
  LayoutDashboardIcon,
  ListFilterIcon,
  LogOutIcon,
  MailIcon,
  MenuIcon,
  SettingsIcon,
  ShieldBanIcon,
} from "lucide-react";
import type * as React from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { aliasesQuery, domainsQuery } from "@/lib/aliases";
import { callApi } from "@/lib/api";
import { inboxesQuery } from "@/lib/inboxes";
import { recipientsQuery } from "@/lib/recipients";
import { forgetSession, meQuery } from "@/lib/session";

type Destination =
  | "/"
  | "/aliases"
  | "/inbox"
  | "/destinations"
  | "/domains"
  | "/blocklist"
  | "/rules"
  | "/settings";

/** How many rows a list holds, once it has loaded. */
const countOf = <A,>(rows: Option.Option<ReadonlyArray<A>>) => Option.map(rows, Arr.length);

/**
 * One navigation entry. Inside the mobile sheet, `isClosing` makes a click also close the sheet.
 */
const NavItem = ({
  to,
  icon,
  label,
  count,
  isClosing,
}: {
  readonly to: Destination;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly count: Option.Option<number>;
  readonly isClosing: boolean;
}) => {
  const pathname = useLocation({ select: (location) => location.pathname });
  const link = <Link to={to} />;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={pathname === to}
        render={isClosing ? <SheetClose nativeButton={false} render={link} /> : link}
      >
        {icon}
        <span>{label}</span>
      </SidebarMenuButton>
      {Option.match(count, {
        onNone: () => null,
        onSome: (value) => <SidebarMenuBadge className="data">{value}</SidebarMenuBadge>,
      })}
    </SidebarMenuItem>
  );
};

const Account = () => {
  const me = useQuery(meQuery);
  const domains = useQuery(domainsQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => callApi((api) => api.auth.logout()),
    onSuccess: () => {
      forgetSession(queryClient);
      void navigate({ to: "/" });
    },
  });

  return Option.match(me.data ?? Option.none(), {
    onNone: () => null,
    onSome: (user) => (
      <div className="flex items-center gap-2 rounded-lg border border-sidebar-border bg-background p-2">
        <Avatar>
          <AvatarFallback>{Str.toUpperCase(Str.slice(0, 2)(user.username))}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium">{user.username}</span>
          {Option.match(Arr.head(domains.data?.subdomains ?? []), {
            onNone: () => null,
            onSome: (subdomain) => (
              <span className="data truncate text-xs text-muted-foreground">{subdomain}</span>
            ),
          })}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Log out"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
        >
          <LogOutIcon />
        </Button>
      </div>
    ),
  });
};

const NavContent = ({ isClosing }: { readonly isClosing: boolean }) => {
  const aliases = useQuery(aliasesQuery);
  const recipients = useQuery(recipientsQuery);
  const inboxes = useQuery(inboxesQuery);
  const domains = useQuery(domainsQuery);
  const domainCount = Option.map(Option.fromUndefinedOr(domains.data), (data) =>
    Arr.length(Arr.appendAll(data.shared, data.subdomains)),
  );

  return (
    <Sidebar className="w-full">
      <SidebarHeader>
        <div className="flex h-8 items-center gap-2 px-1">
          <AtSignIcon className="size-4 text-primary" aria-hidden />
          <span className="text-sm font-semibold tracking-tight">alias</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Main">
          <SidebarGroup>
            <SidebarGroupLabel>Mail</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavItem
                  to="/"
                  icon={<LayoutDashboardIcon />}
                  label="Overview"
                  count={Option.none()}
                  isClosing={isClosing}
                />
                <NavItem
                  to="/aliases"
                  icon={<AtSignIcon />}
                  label="Aliases"
                  count={countOf(Option.fromUndefinedOr(aliases.data))}
                  isClosing={isClosing}
                />
                <NavItem
                  to="/inbox"
                  icon={<MailIcon />}
                  label="Inbox"
                  count={countOf(Option.fromUndefinedOr(inboxes.data))}
                  isClosing={isClosing}
                />
                <NavItem
                  to="/destinations"
                  icon={<InboxIcon />}
                  label="Destinations"
                  count={countOf(Option.fromUndefinedOr(recipients.data))}
                  isClosing={isClosing}
                />
                <NavItem
                  to="/domains"
                  icon={<GlobeIcon />}
                  label="Domains"
                  count={domainCount}
                  isClosing={isClosing}
                />
                <NavItem
                  to="/blocklist"
                  icon={<ShieldBanIcon />}
                  label="Blocklist"
                  count={Option.none()}
                  isClosing={isClosing}
                />
                <NavItem
                  to="/rules"
                  icon={<ListFilterIcon />}
                  label="Rules"
                  count={Option.none()}
                  isClosing={isClosing}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <nav aria-label="Account">
          <SidebarMenu>
            <NavItem
              to="/settings"
              icon={<SettingsIcon />}
              label="Settings"
              count={Option.none()}
              isClosing={isClosing}
            />
          </SidebarMenu>
        </nav>
        <Account />
      </SidebarFooter>
    </Sidebar>
  );
};

/** The fixed sidebar from `md` up. */
export const AppSidebar = () => (
  <aside className="hidden h-svh w-64 shrink-0 border-r border-sidebar-border md:flex">
    <NavContent isClosing={false} />
  </aside>
);

/** Below `md`, the same navigation slides in from the left. */
export const MobileNav = () => (
  <Sheet>
    <SheetTrigger
      render={<Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Menu" />}
    >
      <MenuIcon />
    </SheetTrigger>
    <SheetContent side="left" className="w-64 gap-0 p-0" showCloseButton={false}>
      <SheetTitle className="sr-only">Navigation</SheetTitle>
      <NavContent isClosing />
    </SheetContent>
  </Sheet>
);
