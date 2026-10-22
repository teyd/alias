import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { settingsQuery, updateSettings } from "@/lib/settings";

/** Tracker protection on forwarded mail (PLAN.md §20.19): tracking pixels and link tracking. */
export const TrackerSettings = () => {
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery);
  const update = useMutation({
    mutationFn: updateSettings,
    onSuccess: (stored) => queryClient.setQueryData(settingsQuery.queryKey, stored),
  });
  const isBusy = !settings.isSuccess || update.isPending;

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span id="trackers-label" className="font-medium">
            Block tracking pixels
          </span>
          <span id="trackers-description" className="text-xs text-muted-foreground">
            Removes invisible images and images from known trackers, which tell the sender when and
            where you opened their mail.
          </span>
        </div>
        <Switch
          aria-labelledby="trackers-label"
          aria-describedby="trackers-description"
          aria-busy={isBusy}
          checked={settings.data?.imageProtection !== "off"}
          disabled={isBusy}
          onCheckedChange={(isEnabled) =>
            update.mutate({ imageProtection: isEnabled ? "block-trackers" : "off" })
          }
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span id="links-label" className="font-medium">
            Remove tracking from links
          </span>
          <span id="links-description" className="text-xs text-muted-foreground">
            Strips parameters such as <span className="data">utm_source</span> or{" "}
            <span className="data">fbclid</span> from links. A few sites need them, so it's off
            unless you turn it on.
          </span>
        </div>
        <Switch
          aria-labelledby="links-label"
          aria-describedby="links-description"
          aria-busy={isBusy}
          checked={settings.data?.isLinkCleaningEnabled ?? false}
          disabled={isBusy}
          onCheckedChange={(isEnabled) => update.mutate({ isLinkCleaningEnabled: isEnabled })}
        />
      </div>
      {update.isError && (
        <span role="alert" className="text-xs text-destructive">
          Couldn't save the setting. Please try again.
        </span>
      )}
    </div>
  );
};
