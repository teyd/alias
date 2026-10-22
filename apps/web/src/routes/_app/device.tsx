import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { CheckIcon, MonitorSmartphoneIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { Page } from "@/components/Page";
import { Problem } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { callDevice, deviceRequestQuery } from "@/lib/device";
import { SCOPE_LABELS } from "@/lib/scopes";

/** `alias login` links here with its code; the outcome stays in the URL too. */
const Search = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Literals(["approved", "denied"])),
});

const EnterCode = () => {
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Connect a device</CardTitle>
        <CardDescription>Enter the code your terminal shows after `alias login`.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const code = new FormData(event.currentTarget).get("code");
            void navigate({ search: { code: P.isString(code) ? code.trim() : "" } });
          }}
        >
          <Field>
            <FieldLabel htmlFor="device-code">Code</FieldLabel>
            <Input
              id="device-code"
              name="code"
              className="data uppercase"
              autoComplete="off"
              placeholder="BCDF-GHJK"
              required
            />
            <FieldDescription>Eight letters. Dashes and case don't matter.</FieldDescription>
          </Field>
          <Button type="submit" className="self-start">
            Continue
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

const Decide = ({ code }: { readonly code: string }) => {
  const navigate = useNavigate({ from: Route.fullPath });
  const request = useQuery(deviceRequestQuery(code));
  const decide = useMutation({
    mutationFn: (isApproved: boolean) =>
      callDevice((api) =>
        isApproved
          ? api.device.approve({ payload: { userCode: code } })
          : api.device.deny({ payload: { userCode: code } }),
      ),
    onSuccess: (_, isApproved) =>
      void navigate({ search: { result: isApproved ? "approved" : "denied" }, replace: true }),
  });

  if (request.isPending) return null;
  if (request.isError) {
    return (
      <div className="flex max-w-md flex-col items-start gap-3">
        <Problem error={request.error} />
        <Button variant="outline" onClick={() => void navigate({ search: {} })}>
          Enter another code
        </Button>
      </div>
    );
  }
  const found = request.data;
  return (
    <Card className="max-w-md" role="region" aria-label="Device sign-in request">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorSmartphoneIcon className="size-4" aria-hidden />
          {found.clientName} wants to sign in
        </CardTitle>
        <CardDescription>
          Check that your terminal shows{" "}
          <span className="data text-foreground">{found.userCode}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">It will be able to:</span>
          <ul className="list-inside list-disc" aria-label="Requested access">
            {Arr.map(found.scopes, (scope) => (
              <li key={scope}>{SCOPE_LABELS[scope]}</li>
            ))}
          </ul>
          <span className="text-xs text-muted-foreground">
            For 90 days, until you sign in again or revoke its token under Settings.
          </span>
        </div>
        <Alert variant="destructive">
          <ShieldAlertIcon />
          <AlertTitle>Only approve a sign-in you started</AlertTitle>
          <AlertDescription>
            If someone sent you this link or code, deny it: approving gives them access to your
            aliases.
          </AlertDescription>
        </Alert>
        <Problem error={decide.error} />
        <div className="flex gap-2">
          <Button disabled={decide.isPending} onClick={() => decide.mutate(true)}>
            <CheckIcon />
            Approve
          </Button>
          <Button
            variant="outline"
            disabled={decide.isPending}
            onClick={() => decide.mutate(false)}
          >
            <XIcon />
            Deny
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

const Done = ({ result }: { readonly result: "approved" | "denied" }) => (
  <Alert className="max-w-md" role="status">
    {result === "approved" ? <CheckIcon /> : <XIcon />}
    <AlertTitle>{result === "approved" ? "Device connected" : "Sign-in denied"}</AlertTitle>
    <AlertDescription>
      {result === "approved"
        ? "Go back to your terminal; it signs in within a few seconds."
        : "The device gets no access. You can close this page."}
    </AlertDescription>
  </Alert>
);

/** The approval page of a device login (`alias login`, RFC 8628). */
const Device = () => {
  const search = Route.useSearch();
  return (
    <Page title="Connect a device">
      {P.isNotUndefined(search.result) ? (
        <Done result={search.result} />
      ) : P.isString(search.code) && Str.isNonEmpty(search.code) ? (
        <Decide code={search.code} />
      ) : (
        <EnterCode />
      )}
    </Page>
  );
};

export const Route = createFileRoute("/_app/device")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  component: Device,
});
