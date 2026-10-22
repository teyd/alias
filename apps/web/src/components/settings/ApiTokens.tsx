import { Scope, type Token } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import { KeyRoundIcon } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { Problem } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { callTokens, noScopePicked, tokensQuery } from "@/lib/tokens";

const date = (at: DateTime.Utc) => DateTime.format(at, { dateStyle: "medium" });

const isScope = Schema.is(Scope);

const TokenRow = ({ token }: { readonly token: Token }) => {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => callTokens((api) => api.tokens.revoke({ params: { tokenId: token.id } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tokensQuery.queryKey }),
  });
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2 font-medium">
          <KeyRoundIcon className="size-4 text-muted-foreground" aria-hidden />
          {token.name}
          <span className="data text-xs text-muted-foreground">alias_pat_…{token.hint}</span>
        </span>
        <span className="flex flex-wrap gap-1">
          {token.scopes.map((scope) => (
            <Badge key={scope} variant="secondary" className="data">
              {scope}
            </Badge>
          ))}
        </span>
        <span className="text-xs text-muted-foreground">
          Created {date(token.createdAt)} ·{" "}
          {Option.match(token.lastUsedAt, {
            onNone: () => "never used",
            onSome: (at) => `last used ${date(at)}`,
          })}{" "}
          ·{" "}
          {Option.match(token.expiresAt, {
            onNone: () => "never expires",
            onSome: (at) => `expires ${date(at)}`,
          })}
        </span>
        <Problem error={revoke.error} />
      </div>
      <Button variant="ghost" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
        Revoke
      </Button>
    </li>
  );
};

/** Personal API tokens for the CLI and scripts: list, create (secret shown once), revoke. */
export const ApiTokens = () => {
  const tokens = useQuery(tokensQuery);
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: (form: FormData) => {
      const name = form.get("name");
      const days = Number(form.get("expiresInDays"));
      const scopes = Arr.filter(form.getAll("scopes"), isScope);
      if (!Arr.isArrayNonEmpty(scopes)) return noScopePicked();
      const payload = { name: P.isString(name) ? name : "", scopes };
      return callTokens((api) =>
        api.tokens.create({ payload: days > 0 ? { ...payload, expiresInDays: days } : payload }),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tokensQuery.queryKey }),
  });

  return (
    <div className="flex flex-col gap-4">
      {tokens.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tokens.isError ? (
        <Problem error={tokens.error} />
      ) : (
        Arr.match(tokens.data, {
          onEmpty: () => <p className="text-sm text-muted-foreground">No tokens yet.</p>,
          onNonEmpty: (rows) => (
            <ul className="flex flex-col gap-2">
              {rows.map((token) => (
                <TokenRow key={token.id} token={token} />
              ))}
            </ul>
          ),
        })
      )}
      {create.isSuccess && (
        <div className="flex flex-col gap-2 rounded-lg border bg-muted p-3">
          <span className="text-sm font-medium">
            Copy your new token now. You won't see it again.
          </span>
          <span className="flex items-center gap-1">
            <span className="data truncate">{create.data.token}</span>
            <CopyButton text={create.data.token} label="Copy token" />
          </span>
        </div>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(new FormData(event.currentTarget));
        }}
      >
        <Field>
          <FieldLabel htmlFor="token-name">New token</FieldLabel>
          <Input id="token-name" name="name" placeholder="laptop CLI" maxLength={64} required />
        </Field>
        <fieldset className="grid grid-cols-2 gap-1 text-sm">
          <legend className="mb-1 text-sm font-medium">Scopes</legend>
          {Scope.literals.map((scope) => (
            <label key={scope} className="flex items-center gap-2">
              <input type="checkbox" name="scopes" value={scope} />
              <span className="data">{scope}</span>
            </label>
          ))}
        </fieldset>
        <Field>
          <FieldLabel htmlFor="token-expiry">Expires</FieldLabel>
          <select
            id="token-expiry"
            name="expiresInDays"
            defaultValue="90"
            className="h-8 w-48 rounded-md border bg-transparent px-2 text-sm"
          >
            <option value="7">in 7 days</option>
            <option value="30">in 30 days</option>
            <option value="90">in 90 days</option>
            <option value="365">in a year</option>
            <option value="0">never</option>
          </select>
          <FieldDescription>
            Tokens can't manage tokens or webhooks, or delete the account.
          </FieldDescription>
        </Field>
        <Button type="submit" disabled={create.isPending} className="self-start">
          {create.isPending ? "Creating…" : "Create token"}
        </Button>
        <Problem error={create.error} />
      </form>
    </div>
  );
};
