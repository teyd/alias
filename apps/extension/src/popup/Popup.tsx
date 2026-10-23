import { useForm, useStore } from "@tanstack/react-form";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { type AliasKind, Answer, Request, Status } from "../Messages.ts";
import * as Server from "../Server.ts";
import * as Site from "../Site.ts";
import { activeTab, allowServer, ask, PopupError } from "./send.ts";

const statusQuery = queryOptions({
  queryKey: ["status"],
  queryFn: () => ask(Request.cases.GetStatus.make({}), Status),
});

const tabQuery = queryOptions({ queryKey: ["tab"], queryFn: activeTab });

const subdomainsQuery = queryOptions({
  queryKey: ["subdomains"],
  queryFn: () => ask(Request.cases.ListSubdomains.make({}), Answer.cases.Subdomains),
});

const recentQuery = queryOptions({
  queryKey: ["recent"],
  queryFn: () => ask(Request.cases.ListRecent.make({}), Answer.cases.Recent),
});

/** A line under the controls: what just happened, or what went wrong. */
const Note = ({ text }: { readonly text: Option.Option<string> }) =>
  Option.match(text, { onNone: () => null, onSome: (line) => <p role="status">{line}</p> });

const errorText = (error: Option.Option<Error>) =>
  Option.map(error, (failure) =>
    failure instanceof PopupError ? failure.message : "Something went wrong. Try again.",
  );

const SignInForm = ({ server }: { readonly server: Option.Option<string> }) => {
  const queryClient = useQueryClient();
  const signIn = useMutation({
    mutationFn: async (typed: string) => {
      const origin = Option.getOrThrowWith(
        Server.parse(typed),
        () => new PopupError({ message: "Enter your Alias server's address, like alias.example." }),
      );
      // Asked within the click: browsers prompt for a permission only on a user's gesture.
      if (!(await allowServer(Server.permissionPattern(origin)))) {
        throw new PopupError({ message: "The extension needs access to that server to sign in." });
      }
      return ask(Request.cases.SignIn.make({ server: origin }), Status);
    },
    onSuccess: (status) => queryClient.setQueryData(statusQuery.queryKey, status),
  });
  const defaultValues = { server: Option.getOrElse(server, () => "") };
  const form = useForm({
    defaultValues,
    onSubmit: ({ value }) => {
      signIn.mutate(value.server);
    },
  });
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <h1>Sign in to Alias</h1>
      <form.Field name="server">
        {(field) => (
          <label className="field">
            <span>Server</span>
            <input
              name={field.name}
              value={field.state.value}
              placeholder="alias.example"
              autoComplete="url"
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
        )}
      </form.Field>
      <button type="submit" className="primary" disabled={signIn.isPending}>
        Sign in
      </button>
      <Note
        text={
          signIn.isPending
            ? Option.some("Continue in the sign-in window.")
            : errorText(Option.fromNullishOr(signIn.error))
        }
      />
    </form>
  );
};

const RecentAliases = ({ onCopy }: { readonly onCopy: (address: string) => void }) => {
  const recent = useQuery(recentQuery);
  return Arr.match(recent.data?.aliases ?? [], {
    onEmpty: () => null,
    onNonEmpty: (aliases) => (
      <section>
        <h2>Recent aliases</h2>
        <ul>
          {aliases.map((alias) => (
            <li key={alias.address} className="row">
              <span className={alias.isActive ? "data" : "data muted"}>{alias.address}</span>
              <button
                type="button"
                className="link"
                aria-label={`Copy ${alias.address}`}
                onClick={() => onCopy(alias.address)}
              >
                Copy
              </button>
            </li>
          ))}
        </ul>
      </section>
    ),
  });
};

/**
 * "Alias for example.co.uk: example@ada.alias.example", on the subdomain of the username picked
 * below it when the account has more than one (PLAN.md §20.34), the primary one's first.
 */
const SiteAlias = ({
  site,
  isPending,
  onCreate,
}: {
  readonly site: Site.Site;
  readonly isPending: boolean;
  readonly onCreate: (subdomain: string) => void;
}) => {
  const subdomains = useQuery(subdomainsQuery).data?.subdomains ?? [];
  const form = useForm({ defaultValues: { subdomain: "" } });
  const chosen = useStore(form.store, (state) => state.values.subdomain);
  return Option.match(
    Option.orElse(
      Arr.findFirst(subdomains, (own) => own === chosen),
      () => Arr.head(subdomains),
    ),
    {
      onNone: () => null,
      onSome: (subdomain) => (
        <div className="stack">
          <button
            type="button"
            className="primary"
            disabled={isPending}
            onClick={() => onCreate(subdomain)}
          >
            Alias for {site.domain}:{" "}
            <span className="data">{`${site.localPart}@${subdomain}`}</span>
          </button>
          {subdomains.length > 1 && (
            <form.Field name="subdomain">
              {(field) => (
                <label className="field">
                  <span>Username</span>
                  <select
                    name={field.name}
                    value={subdomain}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    {subdomains.map((own) => (
                      <option key={own} value={own}>
                        {own}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </form.Field>
          )}
        </div>
      ),
    },
  );
};

const SignedInView = ({ status }: { readonly status: Status & { readonly _tag: "SignedIn" } }) => {
  const queryClient = useQueryClient();
  const tab = Option.flatten(Option.fromNullishOr(useQuery(tabQuery).data));
  const site = Option.flatMap(tab, (open) => Site.fromUrl(open.url));
  const copy = useMutation({
    mutationFn: (address: string) => navigator.clipboard.writeText(address),
  });
  const create = useMutation({
    mutationFn: ({ kind, subdomain }: { kind: AliasKind; subdomain: Option.Option<string> }) =>
      ask(
        Request.cases.CreateAlias.make({
          kind,
          subdomain,
          tabId: Option.getOrThrowWith(tab, () => new PopupError({ message: "No open tab." })).id,
        }),
        Answer.cases.Created,
      ),
    onSuccess: (created) => {
      copy.mutate(created.address);
      void queryClient.invalidateQueries({ queryKey: recentQuery.queryKey });
    },
  });
  const fill = useMutation({
    mutationFn: (address: string) =>
      ask(
        Request.cases.Fill.make({
          address,
          tabId: Option.getOrThrowWith(tab, () => new PopupError({ message: "No open tab." })).id,
        }),
        Answer.cases.Filled,
      ),
  });
  const signOut = useMutation({
    mutationFn: () => ask(Request.cases.SignOut.make({}), Status),
    onSuccess: (signedOut) => queryClient.setQueryData(statusQuery.queryKey, signedOut),
  });
  const created = Option.fromNullishOr(create.data);

  return (
    <div className="stack">
      <header className="row">
        <h1>Alias</h1>
        <span className="muted" title={status.server}>
          {status.username}
        </span>
        <button type="button" className="link" onClick={() => signOut.mutate()}>
          Sign out
        </button>
      </header>
      {Option.match(site, {
        onNone: () => null,
        onSome: (found) => (
          <SiteAlias
            site={found}
            isPending={create.isPending}
            onCreate={(subdomain) =>
              create.mutate({ kind: "site", subdomain: Option.some(subdomain) })
            }
          />
        ),
      })}
      <button
        type="button"
        disabled={create.isPending || Option.isNone(tab)}
        onClick={() => create.mutate({ kind: "random", subdomain: Option.none() })}
      >
        New random alias
      </button>
      {Option.match(created, {
        onNone: () => null,
        onSome: (alias) => (
          <div className="result">
            <span className="data">{alias.address}</span>
            <button type="button" className="link" onClick={() => copy.mutate(alias.address)}>
              Copy
            </button>
            <button type="button" className="link" onClick={() => fill.mutate(alias.address)}>
              Fill in
            </button>
          </div>
        ),
      })}
      <Note
        text={Option.firstSomeOf([
          errorText(Option.fromNullishOr(create.error)),
          errorText(Option.fromNullishOr(fill.error)),
          errorText(Option.fromNullishOr(signOut.error)),
          Option.map(Option.fromNullishOr(fill.data), (filled) =>
            filled.isFilled ? "Filled in." : "No field to fill: click into the email field first.",
          ),
          Option.map(created, (alias) =>
            Arr.join(
              Arr.getSomes([
                Option.some(alias.isNew ? "Created" : "You already had this one"),
                alias.isFilled ? Option.some("filled in") : Option.none(),
                copy.isSuccess ? Option.some("copied") : Option.none(),
              ]),
              ", ",
            ).concat("."),
          ),
          copy.isSuccess ? Option.some("Copied.") : Option.none(),
        ])}
      />
      <RecentAliases onCopy={(address) => copy.mutate(address)} />
    </div>
  );
};

export const Popup = () => {
  const status = useQuery(statusQuery);
  return Option.match(Option.fromNullishOr(status.data), {
    onNone: () => <Note text={errorText(Option.fromNullishOr(status.error))} />,
    onSome: (current) =>
      Status.match(current, {
        SignedOut: ({ server }) => <SignInForm server={server} />,
        SignedIn: (signedIn) => <SignedInView status={signedIn} />,
      }),
  });
};
