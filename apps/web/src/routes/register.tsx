import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api";
import { signUp } from "@/lib/passkeys";
import { meQuery } from "@/lib/session";

const Register = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const register = useMutation({
    mutationFn: (name: string) => callApi((api) => signUp(api, name)),
    onSuccess: (me) => {
      queryClient.setQueryData(meQuery.queryKey, Option.some(me));
      void navigate({ to: "/" });
    },
  });

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>
          Your username becomes your own mail subdomain, so pick it with care. You sign in with a
          passkey, no password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const username = new FormData(event.currentTarget).get("username");
            register.mutate(P.isString(username) ? username : "");
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              name="username"
              autoComplete="username webauthn"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={register.isError}
              required
            />
          </div>
          {register.isError && (
            <p role="alert" className="text-sm text-destructive">
              {register.error.message}
            </p>
          )}
          <Button type="submit" disabled={register.isPending}>
            {register.isPending ? "Waiting for your passkey…" : "Create passkey"}
          </Button>
          <p className="text-sm text-muted-foreground">
            Already have one?{" "}
            <Link to="/login" className="underline">
              Log in
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
};

export const Route = createFileRoute("/register")({ component: Register });
