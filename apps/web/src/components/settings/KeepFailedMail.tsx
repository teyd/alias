import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { settingsQuery, updateSettings } from "@/lib/settings";

/** The opt-in to keep a sealed copy of mail that couldn't be forwarded (PLAN.md §20.33). */
export const KeepFailedMail = () => {
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery);
  const update = useMutation({
    mutationFn: updateSettings,
    onSuccess: (stored) => queryClient.setQueryData(settingsQuery.queryKey, stored),
  });
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div className="flex flex-col gap-0.5">
        <span id="keep-failed-label" className="font-medium">
          Keep failed mail for 7 days
        </span>
        <span id="keep-failed-description" className="text-xs text-muted-foreground">
          When a message can't be forwarded, keep it encrypted with its entry under Failed
          deliveries, so you can download it or send it again. Off, only when, which alias, who
          wrote and why are recorded.
        </span>
        {update.isError && (
          <span role="alert" className="text-xs text-destructive">
            Couldn't save the setting. Please try again.
          </span>
        )}
      </div>
      <Switch
        aria-labelledby="keep-failed-label"
        aria-describedby="keep-failed-description"
        aria-busy={!settings.isSuccess || update.isPending}
        checked={settings.data?.isFailedMailKept ?? false}
        disabled={!settings.isSuccess || update.isPending}
        onCheckedChange={(isKept) => update.mutate({ isFailedMailKept: isKept })}
      />
    </div>
  );
};
