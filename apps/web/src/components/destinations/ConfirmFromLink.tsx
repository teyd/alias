import type { Recipient } from "@alias/contracts";
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { CircleCheckIcon, CircleXIcon, LoaderIcon, SendIcon } from "lucide-react";
import { Problem } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { callRecipients, recipientsQuery } from "@/lib/recipients";

/** What the confirmation mail links to: `/destinations?confirm=<recipientId>&token=<token>`. */
interface Link {
  readonly recipientId: string;
  readonly token: string;
}

/**
 * Posts the link's token once per page load. A query rather than a mutation, so the cache, not
 * component state, makes it happen exactly once: StrictMode's second mount and every re-render
 * find the same entry, which never goes stale, never retries (the token is single-use) and isn't
 * under the `recipients` key, so refreshing the list can't post it again.
 */
const confirmQuery = (queryClient: QueryClient, link: Link) =>
  queryOptions({
    queryKey: ["confirmation-link", link.recipientId, link.token],
    queryFn: async () => {
      const recipient = await callRecipients((api) =>
        api.recipients.confirm({
          params: { recipientId: link.recipientId },
          payload: { token: link.token },
        }),
      );
      void queryClient.invalidateQueries({ queryKey: recipientsQuery.queryKey });
      return recipient;
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

const ConfirmedNote = ({
  recipient,
  isNew,
}: {
  readonly recipient: Recipient;
  readonly isNew: boolean;
}) => (
  <Alert role="status" aria-label="Confirmation link">
    <CircleCheckIcon className="text-success" />
    <AlertTitle>
      <span className="data">{recipient.address}</span>{" "}
      {isNew ? "is confirmed" : "is already confirmed"}
    </AlertTitle>
    <AlertDescription>
      {isNew ? "Aliases can forward there now." : "Aliases forward there. This link isn't needed."}
    </AlertDescription>
  </Alert>
);

/** Opening the link: confirming, then on to `?confirmed=`, or why it failed. */
const Confirming = ({ link }: { readonly link: Link }) => {
  const queryClient = useQueryClient();
  const confirm = useQuery(confirmQuery(queryClient, link));
  const recipients = useQuery(recipientsQuery);
  const resend = useMutation({
    mutationFn: (recipientId: string) =>
      callRecipients((api) => api.recipients.resend({ params: { recipientId } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: recipientsQuery.queryKey }),
  });

  if (confirm.isPending) {
    return (
      <Alert role="status" aria-label="Confirmation link">
        <LoaderIcon className="animate-spin" />
        <AlertTitle>Confirming your destination…</AlertTitle>
      </Alert>
    );
  }
  if (confirm.isSuccess) {
    // The token is spent: drop it from the URL (and history) and say what happened.
    return <Navigate to="/destinations" search={{ confirmed: confirm.data.id }} replace />;
  }

  // The link's recipient, if it is in this account.
  const known = Arr.findFirst(
    recipients.data ?? [],
    (recipient) => recipient.id === link.recipientId,
  );
  const working = Option.filter(
    known,
    (recipient) => recipient.isVerified && Option.isNone(recipient.bouncedAt),
  );
  if (Option.isSome(working)) {
    // An old or reused link for a destination that works: nothing to fix.
    return <ConfirmedNote recipient={working.value} isNew={false} />;
  }
  return (
    <Alert variant="destructive" aria-label="Confirmation link">
      <CircleXIcon />
      <AlertTitle>Couldn't confirm this destination</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <Problem error={confirm.error} />
        {Option.match(known, {
          onNone: () =>
            recipients.isSuccess && (
              <span>
                If another Alias account added it, log out and open the link again while signed in
                to that account.
              </span>
            ),
          onSome: (recipient) =>
            resend.isSuccess ? (
              <span>
                A new link is on its way to <span className="data">{recipient.address}</span>.
              </span>
            ) : (
              <>
                <Problem error={resend.error} />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resend.isPending}
                  onClick={() => resend.mutate(recipient.id)}
                >
                  <SendIcon />
                  {resend.isPending ? "Sending…" : "Send a new link"}
                </Button>
              </>
            ),
        })}
      </AlertDescription>
    </Alert>
  );
};

const Confirmed = ({ recipientId }: { readonly recipientId: string }) => {
  const recipients = useQuery(recipientsQuery);
  return Option.match(
    Arr.findFirst(
      recipients.data ?? [],
      (recipient) => recipient.id === recipientId && recipient.isVerified,
    ),
    {
      onNone: () => null,
      onSome: (recipient) => <ConfirmedNote recipient={recipient} isNew />,
    },
  );
};

/**
 * Confirms the destination in the confirmation link as soon as the page opens, without another
 * click, then replaces `confirm`/`token` in the URL with `confirmed=<recipientId>`.
 *
 * The click used to be the guard against link scanners; it isn't needed: the confirm POST needs
 * the owner's session (the `SameSite=Strict` cookie and the API's same-origin check, SR-14), and a
 * link scanner or the mailbox provider's prefetch fetches the link without one, so it can't
 * confirm anything. Signed out, the session gate shows the login in place and keeps the URL, and
 * this mounts and confirms once the owner has signed in.
 */
export const ConfirmFromLink = ({
  link,
  confirmed,
}: {
  readonly link: Option.Option<Link>;
  readonly confirmed: Option.Option<string>;
}) =>
  Option.match(link, {
    onSome: (present) => <Confirming key={present.token} link={present} />,
    onNone: () =>
      Option.match(confirmed, {
        onNone: () => null,
        onSome: (recipientId) => <Confirmed recipientId={recipientId} />,
      }),
  });
