import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { FingerprintIcon } from "lucide-react";
import { AuthFrame } from "@/components/AuthFrame";
import { HumanCheck } from "@/components/HumanCheck";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { callApi } from "@/lib/api";
import { signUp } from "@/lib/passkeys";
import { meQuery } from "@/lib/session";
import { signupQuery } from "@/lib/turnstile";

/** `?invite=` fills in the invite code, so an invitation can be a link (PLAN.md §20.36). */
const Search = Schema.Struct({ invite: Schema.optionalKey(Schema.String) });

const Register = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { invite } = Route.useSearch();
  // During the private beta sign-up takes an invite code; the API says whether it does.
  const isInviteRequired = Option.exists(
    Option.fromUndefinedOr(useQuery(signupQuery).data),
    (config) => config.isInviteRequired,
  );
  const register = useMutation({
    mutationFn: (input: {
      readonly username: string;
      readonly turnstileToken: string;
      readonly inviteCode: string;
    }) => callApi((api) => signUp(api, input)),
    onSuccess: (me) => {
      queryClient.setQueryData(meQuery.queryKey, Option.some(me));
      void navigate({ to: "/" });
    },
  });
  // The token is `""` until the Turnstile widget hands one out.
  const form = useForm({
    defaultValues: { username: "", turnstileToken: "", inviteCode: invite ?? "" },
    onSubmit: ({ value }) => {
      // Single-use: the next attempt waits for the fresh widget's token.
      form.setFieldValue("turnstileToken", "");
      register.mutate(value);
    },
  });
  const hasToken = useStore(form.store, (state) => Str.isNonEmpty(state.values.turnstileToken));

  return (
    <AuthFrame title="Create your account" description="You sign in with a passkey, no password.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="username">
          {(field) => (
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
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              {register.isError ? (
                <FieldError>{register.error.message}</FieldError>
              ) : (
                <FieldDescription>
                  It becomes your own mail subdomain, so pick it with care.
                </FieldDescription>
              )}
            </Field>
          )}
        </form.Field>
        {isInviteRequired ? (
          <form.Field name="inviteCode">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="invite-code">Invite code</FieldLabel>
                <Input
                  id="invite-code"
                  name="invite-code"
                  className="data"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  required
                  placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldDescription>
                  Alias is in private beta, so sign-up needs an invite.
                </FieldDescription>
              </Field>
            )}
          </form.Field>
        ) : null}
        {/* A new widget for every attempt, since each token is redeemed once. */}
        <HumanCheck
          key={register.submittedAt}
          onToken={(token) => form.setFieldValue("turnstileToken", token)}
        />
        <Button type="submit" disabled={register.isPending || !hasToken}>
          <FingerprintIcon />
          {register.isPending
            ? "Waiting for your passkey…"
            : hasToken
              ? "Create passkey"
              : "Checking you're human…"}
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

export const Route = createFileRoute("/register")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  component: Register,
});
