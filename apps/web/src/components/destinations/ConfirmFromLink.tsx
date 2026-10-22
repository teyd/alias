import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MailCheckIcon } from "lucide-react";
import { Problem } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { callRecipients, recipientsQuery } from "@/lib/recipients";

/**
 * Asks before posting the token from the confirmation link, so only a deliberate click by the
 * signed-in owner confirms (not a link scanner, and not twice), then drops it from the URL.
 */
export const ConfirmFromLink = ({
  recipientId,
  token,
}: {
  readonly recipientId: string;
  readonly token: string;
}) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useMutation({
    mutationFn: () =>
      callRecipients((api) =>
        api.recipients.confirm({ params: { recipientId }, payload: { token } }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: recipientsQuery.queryKey });
      void navigate({ to: "/destinations", search: {}, replace: true });
    },
  });

  return (
    <Alert role="region" aria-label="Confirmation link">
      <MailCheckIcon />
      <AlertTitle>You opened a confirmation link for a destination</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>Confirm it to start forwarding mail there.</span>
        <Problem error={confirm.error} />
        <Button size="sm" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
          {confirm.isPending ? "Confirming…" : "Confirm this address"}
        </Button>
      </AlertDescription>
    </Alert>
  );
};
