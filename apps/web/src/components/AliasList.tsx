import type { AliasView } from "@alias/contracts";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { ContactList } from "@/components/ContactList";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type Mode,
  aliasesQuery,
  createAlias,
  deleteAlias,
  domainsQuery,
  updateAlias,
} from "@/lib/aliases";
import { setOnTheFly, settingsQuery } from "@/lib/settings";

/** Styled like `Input`; there is no shadcn select in the repo yet. */
const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

const modes: ReadonlyArray<Mode> = ["forward", "inbox", "both"];

const CreateAlias = ({
  shared,
  subdomains,
}: {
  readonly shared: ReadonlyArray<string>;
  readonly subdomains: ReadonlyArray<string>;
}) => {
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: createAlias,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: aliasesQuery.queryKey }),
  });
  const defaultValues = { domain: Option.getOrElse(Arr.head(shared), () => ""), local: "" };
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value, formApi }) => {
      const isSubdomain = Arr.contains(subdomains, value.domain);
      await create.mutateAsync({ domain: value.domain, local: isSubdomain ? value.local : "" });
      formApi.reset();
    },
  });
  const domain = useStore(form.store, (state) => state.values.domain);
  const isSubdomain = Arr.contains(subdomains, domain);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <div className="flex items-end gap-2">
        {isSubdomain && (
          <form.Field name="local">
            {(field) => (
              <div className="flex flex-1 flex-col gap-2">
                <Label htmlFor={field.name}>Address</Label>
                <Input
                  id={field.name}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  placeholder="shop"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </div>
            )}
          </form.Field>
        )}
        <form.Field name="domain">
          {(field) => (
            <div className="flex flex-col gap-2">
              <Label htmlFor={field.name}>{isSubdomain ? "@" : "Random address on"}</Label>
              <select
                id={field.name}
                className={selectClass}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              >
                {Arr.map([...shared, ...subdomains], (option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting}>
              Create
            </Button>
          )}
        </form.Subscribe>
      </div>
      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          {create.error.message}
        </p>
      )}
    </form>
  );
};

const AliasRow = ({
  alias,
  isShowingContacts,
}: {
  readonly alias: AliasView;
  readonly isShowingContacts: boolean;
}) => {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: aliasesQuery.queryKey });
  const update = useMutation({
    mutationFn: (changes: { readonly mode?: Mode; readonly isActive?: boolean }) =>
      updateAlias(alias.address, changes),
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: () => deleteAlias(alias.address), onSettled: refresh });
  const isBusy = update.isPending || remove.isPending;
  const error = update.error ?? remove.error;

  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 flex-col">
          <span
            className={`font-mono text-sm ${alias.isActive ? "" : "text-muted-foreground line-through"}`}
          >
            {alias.address}
          </span>
          <span className="text-xs text-muted-foreground">
            {alias.forwardedCount} forwarded · {alias.blockedCount} blocked
          </span>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link
            to="/"
            search={isShowingContacts ? {} : { contacts: alias.address }}
            aria-expanded={isShowingContacts}
          >
            Contacts
          </Link>
        </Button>
        <select
          aria-label={`Mode of ${alias.address}`}
          className={selectClass}
          value={alias.mode}
          disabled={isBusy}
          onChange={(event) => {
            Option.match(
              Arr.findFirst(modes, (mode) => mode === event.target.value),
              {
                onNone: () => undefined,
                onSome: (mode) => update.mutate({ mode }),
              },
            );
          }}
        >
          {Arr.map(modes, (mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          size="sm"
          disabled={isBusy}
          onClick={() => update.mutate({ isActive: !alias.isActive })}
        >
          {alias.isActive ? "Disable" : "Enable"}
        </Button>
        <Button variant="destructive" size="sm" disabled={isBusy} onClick={() => remove.mutate()}>
          Delete
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      {isShowingContacts && <ContactList aliasAddress={alias.address} />}
    </li>
  );
};

/** The opt-in for aliases created by the first mail to a new address on the user's subdomain. */
const OnTheFlySetting = ({ subdomains }: { readonly subdomains: ReadonlyArray<string> }) => {
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery);
  const update = useMutation({
    mutationFn: setOnTheFly,
    onSuccess: (stored) => queryClient.setQueryData(settingsQuery.queryKey, stored),
  });
  const example = Option.getOrElse(Arr.head(subdomains), () => "you.alias.example");

  return (
    <div className="flex flex-col gap-1 rounded-md border p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="size-4"
          checked={settings.data?.isOnTheFlyEnabled ?? false}
          disabled={!settings.isSuccess || update.isPending}
          onChange={(event) => update.mutate(event.target.checked)}
        />
        Create aliases on the fly
      </label>
      <p className="text-xs text-muted-foreground">
        Mail to any new address on {example} creates that alias and is forwarded. Off, it is dropped
        until you create the alias here.
      </p>
      {update.isError && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't save the setting. Please try again.
        </p>
      )}
    </div>
  );
};

/**
 * The signed-in user's aliases, with create, enable/disable, mode, delete, their counters, and
 * the contacts of the one named in the URL (`?contacts=<address>`).
 */
export const AliasList = ({ openContacts }: { readonly openContacts: Option.Option<string> }) => {
  const aliases = useQuery(aliasesQuery);
  const domains = useQuery(domainsQuery);

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Your aliases</CardTitle>
        <CardDescription>
          Pick a random address on a shared domain, or any address on your own subdomain.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {domains.isSuccess && (
          <>
            <CreateAlias shared={domains.data.shared} subdomains={domains.data.subdomains} />
            <OnTheFlySetting subdomains={domains.data.subdomains} />
          </>
        )}
        {aliases.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : aliases.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Couldn't load your aliases.
          </p>
        ) : Arr.isReadonlyArrayNonEmpty(aliases.data) ? (
          <ul className="divide-y">
            {Arr.map(aliases.data, (alias) => (
              <AliasRow
                key={alias.id}
                alias={alias}
                isShowingContacts={Option.contains(openContacts, alias.address)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No aliases yet.</p>
        )}
      </CardContent>
    </Card>
  );
};
