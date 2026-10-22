import type { Settings } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { settingsQuery, updateSettings } from "@/lib/settings";

const imageChoices: ReadonlyArray<{
  readonly value: Settings["imageProtection"];
  readonly label: string;
}> = [
  { value: "block-trackers", label: "Block tracking pixels" },
  { value: "proxy-images", label: "Block pixels, proxy images" },
  { value: "off", label: "Leave as they are" },
];

/** Tracker protection on forwarded mail (PLAN.md §20.19): images and link tracking. */
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
          <span id="images-label" className="font-medium">
            Images in forwarded mail
          </span>
          <span id="images-description" className="text-xs text-muted-foreground">
            Tracking pixels tell the sender when and where you opened their mail. The proxy also
            loads every other image through us, so senders never see your address or mail app.
          </span>
        </div>
        <Select
          value={settings.data?.imageProtection ?? "block-trackers"}
          disabled={isBusy}
          onValueChange={(value) =>
            Option.map(
              Arr.findFirst(imageChoices, (choice) => choice.value === value),
              (choice) => update.mutate({ imageProtection: choice.value }),
            )
          }
        >
          <SelectTrigger
            aria-labelledby="images-label"
            aria-describedby="images-description"
            className="w-56 shrink-0"
          >
            <SelectValue>
              {(value: string) =>
                Option.getOrElse(
                  Option.map(
                    Arr.findFirst(imageChoices, (choice) => choice.value === value),
                    (choice) => choice.label,
                  ),
                  () => value,
                )
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {Arr.map(imageChoices, (choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
