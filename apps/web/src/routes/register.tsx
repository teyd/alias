import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { FingerprintIcon } from "lucide-react";
import { AuthFrame } from "@/components/AuthFrame";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
    <AuthFrame title="Create your account" description="You sign in with a passkey, no password.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const username = new FormData(event.currentTarget).get("username");
          register.mutate(P.isString(username) ? username : "");
        }}
      >
        <Field data-invalid={register.isError || undefined}>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input
            id="username"
            name="username"
            className="data"
            autoComplete="username webauthn"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={register.isError}
            required
          />
          {register.isError ? (
            <FieldError>{register.error.message}</FieldError>
          ) : (
            <FieldDescription>
              It becomes your own mail subdomain, so pick it with care.
            </FieldDescription>
          )}
        </Field>
        <Button type="submit" disabled={register.isPending}>
          <FingerprintIcon />
          {register.isPending ? "Waiting for your passkey…" : "Create passkey"}
        </Button>
        <p className="text-muted-foreground">
          Already have one?{" "}
          <Link to="/login" className="text-foreground underline underline-offset-3">
            Log in
          </Link>
        </p>
      </form>
    </AuthFrame>
  );
};

export const Route = createFileRoute("/register")({ component: Register });
