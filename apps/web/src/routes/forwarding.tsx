import type { Recipient } from "@alias/contracts";
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api";
import { logIn } from "@/lib/passkeys";
import { callRecipients, recipientsQuery } from "@/lib/recipients";
import { meQuery } from "@/lib/session";

/** The confirmation mail links here with the recipient ID and its token. */
const Search = Schema.Struct({
  confirm: Schema.optionalKey(Schema.String),
  token: Schema.optionalKey(Schema.String),
});

/** The error of a query or mutation, if it has one. */
const Problem = ({ error }: Pick<UseQueryResult, "error">) =>
  Option.match(Option.fromNullOr(error), {
    onNone: () => null,
    onSome: (present) => (
      <p role="alert" className="text-sm text-destructive">
        {present.message}
      </p>
    ),
  });

const useRefresh = () => {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: recipientsQuery.queryKey });
};

/**
 * Asks before posting the token from the confirmation link, so only a deliberate click by the
 * signed-in owner confirms (not a link scanner, and not twice), then drops it from the URL.
 */
const ConfirmFromLink = ({
  recipientId,
  token,
}: {
  readonly recipientId: string;
  readonly token: string;
}) => {
  const navigate = useNavigate();
  const refresh = useRefresh();
  const confirm = useMutation({
    mutationFn: () =>
      callRecipients((api) =>
        api.recipients.confirm({ params: { recipientId }, payload: { token } }),
      ),
    onSuccess: () => {
      void refresh();
      void navigate({ to: "/forwarding", search: {}, replace: true });
    },
  });
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm">You opened a confirmation link for a forwarding address.</p>
      <Problem error={confirm.error} />
      <Button disabled={confirm.isPending} onClick={() => confirm.mutate()}>
        {confirm.isPending ? "Confirming…" : "Confirm this address"}
      </Button>
    </div>
  );
};

/** One call per row action; each settles to nothing. */
const rowActions = {
  resend: (recipientId: string) =>
    callRecipients((api) => api.recipients.resend({ params: { recipientId } })),
  makeDefault: (recipientId: string) =>
    callRecipients((api) => api.recipients.makeDefault({ params: { recipientId } })),
  remove: (recipientId: string) =>
    callRecipients((api) => api.recipients.remove({ params: { recipientId } })),
} as const;

const RecipientRow = ({ recipient }: { readonly recipient: Recipient }) => {
  const refresh = useRefresh();
  const action = useMutation({
    mutationFn: (kind: keyof typeof rowActions) => rowActions[kind](recipient.id),
    onSuccess: () => refresh(),
  });
  const status = recipient.isDefault
    ? "Default"
    : recipient.isVerified
      ? "Confirmed"
      : "Waiting for confirmation";

  return (
    <li className="flex flex-col gap-2 border-b py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-medium">{recipient.address}</span>
          <span className="text-xs text-muted-foreground">{status}</span>
        </div>
        <div className="flex gap-2">
          {!recipient.isVerified && (
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate("resend")}
            >
              Resend link
            </Button>
          )}
          {recipient.isVerified && !recipient.isDefault && (
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate("makeDefault")}
            >
              Make default
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate("remove")}
          >
            Remove
          </Button>
        </div>
      </div>
      {action.isSuccess && action.variables === "resend" && (
        <p className="text-sm text-muted-foreground">A new link is on its way.</p>
      )}
      <Problem error={action.error} />
    </li>
  );
};

const Recipients = () => {
  const recipients = useQuery(recipientsQuery);
  const refresh = useRefresh();
  const search = Route.useSearch();
  const add = useMutation({
    mutationFn: (address: string) =>
      callRecipients((api) => api.recipients.add({ payload: { address } })),
    onSuccess: () => refresh(),
  });

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Forwarding addresses</CardTitle>
        <CardDescription>
          Mail to your aliases is forwarded to these mailboxes. Each one needs confirming: we mail
          it a link, which you open while signed in.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {P.isString(search.confirm) && P.isString(search.token) && (
          <ConfirmFromLink recipientId={search.confirm} token={search.token} />
        )}
        {recipients.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : recipients.isError ? (
          <Problem error={recipients.error} />
        ) : (
          Arr.match(recipients.data, {
            onEmpty: () => (
              <p className="text-sm text-muted-foreground">No forwarding addresses yet.</p>
            ),
            onNonEmpty: (rows) => (
              <ul>
                {rows.map((recipient) => (
                  <RecipientRow key={recipient.id} recipient={recipient} />
                ))}
              </ul>
            ),
          })
        )}
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const address = new FormData(form).get("address");
            add.mutate(P.isString(address) ? address : "", { onSuccess: () => form.reset() });
          }}
        >
          <Label htmlFor="address">Add an address</Label>
          <div className="flex gap-2">
            <Input
              id="address"
              name="address"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              aria-invalid={add.isError}
              required
            />
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? "Sending…" : "Send link"}
            </Button>
          </div>
          {add.isSuccess && (
            <p className="text-sm text-muted-foreground">
              Check {add.data.address} for the confirmation link.
            </p>
          )}
          <Problem error={add.error} />
        </form>
      </CardContent>
    </Card>
  );
};

/** Signing in here keeps the confirmation link's query, unlike the login page. */
const SignIn = () => {
  const queryClient = useQueryClient();
  const login = useMutation({
    mutationFn: () => callApi(logIn),
    onSuccess: (me) => queryClient.setQueryData(meQuery.queryKey, Option.some(me)),
  });
  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Forwarding addresses</CardTitle>
        <CardDescription>Sign in to manage or confirm your forwarding addresses.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Problem error={login.error} />
        <Button disabled={login.isPending} onClick={() => login.mutate()}>
          {login.isPending ? "Waiting for your passkey…" : "Log in with a passkey"}
        </Button>
      </CardContent>
    </Card>
  );
};

const Forwarding = () => {
  const me = useQuery(meQuery);
  if (me.isPending) return null;
  return Option.match(me.data ?? Option.none(), {
    onNone: () => <SignIn />,
    onSome: () => <Recipients />,
  });
};

export const Route = createFileRoute("/forwarding")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  component: Forwarding,
});
