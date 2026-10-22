import type * as React from "react";
import { MobileNav } from "@/components/AppNav";

/** A signed-in screen: the 48px title bar of the design, then the scrolling content. */
export const Page = ({
  title,
  actions,
  children,
}: {
  readonly title: string;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
}) => (
  <>
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 md:px-6">
      <MobileNav />
      <h1 className="text-sm font-semibold">{title}</h1>
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </header>
    <main className="min-h-0 flex-1 overflow-auto">
      <div className="flex flex-col gap-4 p-4 md:p-6">{children}</div>
    </main>
  </>
);
