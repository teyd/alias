import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AppSidebar } from "@/components/AppNav";
import { SignIn } from "@/components/SignIn";
import { LoadFailed } from "@/components/states";
import { meQuery } from "@/lib/session";

/** Every signed-in screen: the sidebar shell, or the login card in its place when signed out. */
const AppLayout = () => {
  const me = useQuery(meQuery);
  if (me.isPending) return null;
  if (me.isError) {
    return (
      <main className="mx-auto max-w-md p-6">
        <LoadFailed what="your session" onRetry={() => void me.refetch()} />
      </main>
    );
  }
  return Option.match(me.data, {
    onNone: () => <SignIn />,
    onSome: () => (
      <div className="flex h-svh">
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    ),
  });
};

export const Route = createFileRoute("/_app")({ component: AppLayout });
