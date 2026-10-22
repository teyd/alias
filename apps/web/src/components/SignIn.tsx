import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { FingerprintIcon } from "lucide-react";
import { AuthFrame } from "@/components/AuthFrame";
import { Problem } from "@/components/states";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/api";
import { logIn } from "@/lib/passkeys";
import { meQuery } from "@/lib/session";

/**
 * Passkey login. Signing in keeps the current URL, so a confirmation link opened while signed
 * out still confirms afterwards.
 */
export const SignIn = ({ onSignedIn }: { readonly onSignedIn?: () => void }) => {
  const queryClient = useQueryClient();
  const login = useMutation({
    mutationFn: () => callApi(logIn),
    onSuccess: (me) => {
      queryClient.setQueryData(meQuery.queryKey, Option.some(me));
      onSignedIn?.();
    },
  });

  return (
    <AuthFrame title="Log in" description="Use the passkey you created when you signed up.">
      <Problem error={login.error} />
      <Button disabled={login.isPending} onClick={() => login.mutate()}>
        <FingerprintIcon />
        {login.isPending ? "Waiting for your passkey…" : "Log in with a passkey"}
      </Button>
      <p className="text-muted-foreground">
        New here?{" "}
        <Link to="/register" className="text-foreground underline underline-offset-3">
          Create an account
        </Link>
      </p>
    </AuthFrame>
  );
};
