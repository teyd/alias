import { type AuthorizationRequest, Scope } from "@alias/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ShieldAlertIcon } from "lucide-react";
import { AuthFrame } from "@/components/AuthFrame";
import { SignIn } from "@/components/SignIn";
import { Problem } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SCOPE_LABELS, callOAuth, consentQuery, redirectOf } from "@/lib/oauth";
import { meQuery } from "@/lib/session";

/**
 * The OAuth authorization endpoint (PLAN.md §20.24): an MCP client sends the browser here with
 * its request in the query. Signed out, the passkey login shows in place and the page continues
 * afterwards. The API validates the request; this page only shows it and posts the decision.
 */
const Param = Schema.optionalKey(Schema.String);
const Search = Schema.Struct({
  response_type: Param,
  client_id: Param,
  redirect_uri: Param,
  code_challenge: Param,
  code_challenge_method: Param,
  scope: Param,
  state: Param,
  resource: Param,
});
type Search = typeof Search.Type;

const isScope = Schema.is(Scope);

/** The request as the API takes it; missing required parameters become empty, which it refuses. */
const toRequest = (search: Search): AuthorizationRequest => ({
  ...search,
  response_type: search.response_type ?? "",
  client_id: search.client_id ?? "",
  redirect_uri: search.redirect_uri ?? "",
});

/** Leaves for the client's redirect URI, with a code or an error. */
const leave = (redirectTo: string) => window.location.assign(redirectTo);

const Refused = ({ error }: { readonly error: Error }) => (
  <AuthFrame title="Can't connect this app" description={error.message}>
    {Option.match(redirectOf(error), {
      onNone: () => null,
      onSome: (redirectTo) => (
        <Button variant="outline" onClick={() => leave(redirectTo)}>
          Return to the app
        </Button>
      ),
    })}
  </AuthFrame>
);

const ConsentForm = ({ request }: { readonly request: AuthorizationRequest }) => {
  const consent = useQuery(consentQuery(request));
  const decide = useMutation({
    mutationFn: (decision: {
      readonly isApproved: boolean;
      readonly scopes: ReadonlyArray<Scope>;
    }) => callOAuth((api) => api.consent.decide({ payload: { request, ...decision } })),
    onSuccess: ({ redirectTo }) => leave(redirectTo),
  });
  if (consent.isPending) return null;
  if (consent.isError) return <Refused error={consent.error} />;
  const { client, scopes } = consent.data;
  return (
    <AuthFrame
      title={`Connect ${client.name}?`}
      description={
        <>
          It wants to use your Alias account through MCP. Afterwards it is sent to{" "}
          <span className="data text-foreground">{client.redirectHost}</span>.
        </>
      }
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">App ID</dt>
        <dd className="data truncate">{client.id}</dd>
        {Option.match(client.uri, {
          onNone: () => null,
          onSome: (uri) => (
            <>
              <dt className="text-muted-foreground">Website</dt>
              <dd className="data truncate">{uri}</dd>
            </>
          ),
        })}
      </dl>
      {client.kind === "registered" && (
        <Badge variant="warning" className="self-start">
          Name not verified
        </Badge>
      )}
      {client.isLocalRedirect && (
        <Alert>
          <ShieldAlertIcon />
          <AlertTitle>Only continue if you started this</AlertTitle>
          <AlertDescription>
            The app runs on this computer ({client.redirectHost}). Any program here could ask in its
            name.
          </AlertDescription>
        </Alert>
      )}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const picked = Arr.filter(new FormData(event.currentTarget).getAll("scopes"), isScope);
          decide.mutate({ isApproved: true, scopes: picked });
        }}
      >
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1 font-medium">It may</legend>
          {scopes.map((scope) => (
            <label key={scope} className="flex items-start gap-2">
              <input type="checkbox" name="scopes" value={scope} defaultChecked className="mt-1" />
              <span className="flex flex-col">
                <span>{SCOPE_LABELS[scope]}</span>
                <span className="data text-xs text-muted-foreground">{scope}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-muted-foreground">
          You can disconnect it any time under Settings → Connected apps.
        </p>
        <Problem error={decide.error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={decide.isPending}>
            Allow
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ isApproved: false, scopes: [] })}
          >
            Deny
          </Button>
        </div>
      </form>
    </AuthFrame>
  );
};

const Authorize = () => {
  const me = useQuery(meQuery);
  const request = toRequest(Route.useSearch());
  if (me.isPending) return null;
  if (me.isError) return <Refused error={me.error} />;
  return Option.match(me.data, {
    onNone: () => <SignIn />,
    onSome: () => <ConsentForm request={request} />,
  });
};

export const Route = createFileRoute("/oauth/authorize")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  component: Authorize,
});
