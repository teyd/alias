import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { callApi } from "@/lib/api";
import { logIn } from "@/lib/passkeys";
import { meQuery } from "@/lib/session";

const Login = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const login = useMutation({
    mutationFn: () => callApi(logIn),
    onSuccess: (me) => {
      queryClient.setQueryData(meQuery.queryKey, Option.some(me));
      void navigate({ to: "/" });
    },
  });

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Log in</CardTitle>
        <CardDescription>Use the passkey you created when you signed up.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {login.isError && (
          <p role="alert" className="text-sm text-destructive">
            {login.error.message}
          </p>
        )}
        <Button disabled={login.isPending} onClick={() => login.mutate()}>
          {login.isPending ? "Waiting for your passkey…" : "Log in with a passkey"}
        </Button>
        <p className="text-sm text-muted-foreground">
          New here?{" "}
          <Link to="/register" className="underline">
            Create an account
          </Link>
        </p>
      </CardContent>
    </Card>
  );
};

export const Route = createFileRoute("/login")({ component: Login });
