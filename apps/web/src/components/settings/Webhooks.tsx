import { type Webhook, WebhookEventType } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import { WebhookIcon } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { Problem } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { callWebhooks, noEventPicked, webhooksQuery } from "@/lib/webhooks";

const date = (at: DateTime.Utc) => DateTime.format(at, { dateStyle: "medium" });

const isEventType = Schema.is(WebhookEventType);

/** A signing secret the API returned, shown once. */
const SecretOnce = ({ secret, note }: { readonly secret: string; readonly note: string }) => (
  <div className="flex flex-col gap-2 rounded-lg border bg-muted p-3">
    <span className="text-sm font-medium">Copy the signing secret now. {note}</span>
    <span className="flex items-center gap-1">
      <span className="data truncate">{secret}</span>
      <CopyButton text={secret} label="Copy signing secret" />
    </span>
  </div>
);

const WebhookRow = ({ webhook }: { readonly webhook: Webhook }) => {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: webhooksQuery.queryKey });
  const params = { webhookId: webhook.id };
  const toggle = useMutation({
    mutationFn: () =>
      callWebhooks((api) =>
        api.webhooks.update({ params, payload: { isEnabled: !webhook.isEnabled } }),
      ),
    onSuccess: refresh,
  });
  const rotate = useMutation({
    mutationFn: () => callWebhooks((api) => api.webhooks.rotateSecret({ params })),
  });
  const remove = useMutation({
    mutationFn: () => callWebhooks((api) => api.webhooks.remove({ params })),
    onSuccess: refresh,
  });
  const isBusy = toggle.isPending || rotate.isPending || remove.isPending;
  return (
    <li className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2">
            <WebhookIcon className="size-4 text-muted-foreground" aria-hidden />
            <span className="data truncate">{webhook.url}</span>
            <Badge variant={webhook.isEnabled ? "secondary" : "warning"}>
              {webhook.isEnabled ? "Active" : "Paused"}
            </Badge>
          </span>
          <span className="flex flex-wrap gap-1">
            {webhook.eventTypes.map((type) => (
              <Badge key={type} variant="secondary" className="data">
                {type}
              </Badge>
            ))}
          </span>
          <span className="text-xs text-muted-foreground">Added {date(webhook.createdAt)}</span>
        </div>
        <div className="flex gap-1">
          <Button variant="outline" size="sm" disabled={isBusy} onClick={() => toggle.mutate()}>
            {webhook.isEnabled ? "Pause" : "Resume"}
          </Button>
          <Button variant="outline" size="sm" disabled={isBusy} onClick={() => rotate.mutate()}>
            New secret
          </Button>
          <Button variant="ghost" size="sm" disabled={isBusy} onClick={() => remove.mutate()}>
            Remove
          </Button>
        </div>
      </div>
      {rotate.isSuccess && (
        <SecretOnce
          secret={rotate.data.secret}
          note="Deliveries carry signatures from both secrets for 24 hours."
        />
      )}
      <Problem error={toggle.error ?? rotate.error ?? remove.error} />
    </li>
  );
};

/** Webhook endpoints: signed HTTPS POSTs when aliases or mail change. */
export const Webhooks = () => {
  const webhooks = useQuery(webhooksQuery);
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: (form: FormData) => {
      const url = form.get("url");
      const eventTypes = Arr.filter(form.getAll("eventTypes"), isEventType);
      if (!Arr.isArrayNonEmpty(eventTypes)) return noEventPicked();
      return callWebhooks((api) =>
        api.webhooks.create({ payload: { url: P.isString(url) ? url : "", eventTypes } }),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: webhooksQuery.queryKey }),
  });

  return (
    <div className="flex flex-col gap-4">
      {webhooks.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : webhooks.isError ? (
        <Problem error={webhooks.error} />
      ) : (
        Arr.match(webhooks.data, {
          onEmpty: () => <p className="text-sm text-muted-foreground">No webhooks yet.</p>,
          onNonEmpty: (rows) => (
            <ul className="flex flex-col gap-2">
              {rows.map((webhook) => (
                <WebhookRow key={webhook.id} webhook={webhook} />
              ))}
            </ul>
          ),
        })
      )}
      {create.isSuccess && (
        <SecretOnce secret={create.data.secret} note="You won't see it again." />
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(new FormData(event.currentTarget));
        }}
      >
        <Field>
          <FieldLabel htmlFor="webhook-url">New endpoint</FieldLabel>
          <Input
            id="webhook-url"
            name="url"
            type="url"
            className="data"
            placeholder="https://example.com/hooks/alias"
            required
          />
          <FieldDescription>
            HTTPS on a public host. Each POST is signed per Standard Webhooks and carries no message
            content or sender address.
          </FieldDescription>
        </Field>
        <fieldset className="grid grid-cols-2 gap-1 text-sm">
          <legend className="mb-1 text-sm font-medium">Events</legend>
          {WebhookEventType.literals.map((type) => (
            <label key={type} className="flex items-center gap-2">
              <input type="checkbox" name="eventTypes" value={type} />
              <span className="data">{type}</span>
            </label>
          ))}
        </fieldset>
        <Button type="submit" disabled={create.isPending} className="self-start">
          {create.isPending ? "Adding…" : "Add webhook"}
        </Button>
        <Problem error={create.error} />
      </form>
    </div>
  );
};
