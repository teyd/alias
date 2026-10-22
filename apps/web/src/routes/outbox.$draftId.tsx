import type { Draft } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { MailIcon } from "lucide-react";
import { AuthFrame } from "@/components/AuthFrame";
import { SignIn } from "@/components/SignIn";
import { Problem } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { callOutbox, draftQuery } from "@/lib/outbox";
import { meQuery } from "@/lib/session";

/**
 * Where a drafted email waits for its owner (PLAN.md §20.24): an MCP client drafted it with
 * `send_mail`, and only this page, signed in, sends it. The text is shown as plain text, exactly
 * as it would go out.
 */

const STATUS: Record<Draft["status"], string> = {
  pending: "Waiting for you",
  sent: "Sent",
  discarded: "Discarded",
  expired: "Lapsed",
};

const Review = ({ draftId }: { readonly draftId: string }) => {
  const queryClient = useQueryClient();
  const draft = useQuery(draftQuery(draftId));
  const decide = useMutation({
    mutationFn: (isSend: boolean) =>
      callOutbox((api) =>
        isSend
          ? api.outbox.send({ params: { draftId } })
          : api.outbox.discard({ params: { draftId } }),
      ),
    onSuccess: (updated) => queryClient.setQueryData(draftQuery(draftId).queryKey, updated),
  });
  if (draft.isPending) return null;
  if (draft.isError) {
    return (
      <AuthFrame title="Draft not found" description={draft.error.message}>
        {null}
      </AuthFrame>
    );
  }
  const mail = draft.data;
  const isPending = mail.status === "pending";
  return (
    <AuthFrame
      title={isPending ? `Send this email?` : `Email ${STATUS[mail.status].toLowerCase()}`}
      description={
        <>
          <span className="text-foreground">{mail.clientName}</span> drafted it. It goes out only if
          you send it here
          {isPending &&
            `, until ${DateTime.format(mail.expiresAt, { timeStyle: "short", dateStyle: "medium" })}`}
          .
        </>
      }
    >
      <Badge variant={mail.status === "sent" ? "success" : "secondary"} className="self-start">
        {STATUS[mail.status]}
      </Badge>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">From</dt>
        <dd className="data truncate">{mail.from}</dd>
        <dt className="text-muted-foreground">To</dt>
        <dd className="truncate">
          {Option.match(mail.contactName, {
            onNone: () => null,
            onSome: (name) => <span>{name} </span>,
          })}
          <span className="data">{mail.to}</span>
        </dd>
        <dt className="text-muted-foreground">Subject</dt>
        <dd className="truncate font-medium">{mail.subject}</dd>
      </dl>
      <pre
        aria-label="Message"
        className="max-h-80 overflow-auto rounded-lg border bg-muted p-3 text-sm whitespace-pre-wrap"
      >
        {mail.text}
      </pre>
      <Problem error={decide.error} />
      {isPending && (
        <div className="flex gap-2">
          <Button disabled={decide.isPending} onClick={() => decide.mutate(true)}>
            <MailIcon />
            {decide.isPending ? "Sending…" : "Send"}
          </Button>
          <Button
            variant="outline"
            disabled={decide.isPending}
            onClick={() => decide.mutate(false)}
          >
            Discard
          </Button>
        </div>
      )}
    </AuthFrame>
  );
};

const Outbox = () => {
  const me = useQuery(meQuery);
  const { draftId } = Route.useParams();
  if (me.isPending) return null;
  return Option.match(me.data ?? Option.none(), {
    onNone: () => <SignIn />,
    onSome: () => <Review draftId={draftId} />,
  });
};

export const Route = createFileRoute("/outbox/$draftId")({ component: Outbox });
