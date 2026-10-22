import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, createRootRoute, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/api";
import { eraseAccount } from "@/lib/passkeys";
import { meQuery } from "@/lib/session";

const Account = () => {
  const me = useQuery(meQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signedOut = () => {
    queryClient.setQueryData(meQuery.queryKey, Option.none());
    void navigate({ to: "/" });
  };
  const logout = useMutation({
    mutationFn: () => callApi((api) => api.auth.logout()),
    onSuccess: signedOut,
  });
  const erase = useMutation({ mutationFn: () => callApi(eraseAccount), onSuccess: signedOut });

  if (me.isPending) return null;
  return Option.match(me.data ?? Option.none(), {
    onNone: () => (
      <nav className="flex gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/login">Log in</Link>
        </Button>
        <Button asChild size="sm">
          <Link to="/register">Sign up</Link>
        </Button>
      </nav>
    ),
    onSome: (user) => (
      <div className="flex items-center gap-3 text-sm">
        <Button asChild variant="ghost" size="sm">
          <Link to="/forwarding">Forwarding</Link>
        </Button>
        <span className="text-muted-foreground">{user.username}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
        >
          Log out
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          disabled={erase.isPending}
          onClick={() => {
            if (
              window.confirm(
                "Delete your account for good? Every alias, contact and forwarding address is " +
                  `erased, and the username ${user.username} can never be registered again.`,
              )
            ) {
              erase.mutate();
            }
          }}
        >
          Delete account
        </Button>
        {erase.error && (
          <span role="alert" className="text-destructive">
            {erase.error.message}
          </span>
        )}
      </div>
    ),
  });
};

export const Route = createRootRoute({
  component: () => (
    <main className="mx-auto max-w-2xl p-8 font-sans">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          <Link to="/">Alias</Link>
        </h1>
        <Account />
      </header>
      <Outlet />
    </main>
  ),
});
