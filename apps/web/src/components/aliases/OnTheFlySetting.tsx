import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Switch } from "@/components/ui/switch";
import { setOnTheFly, settingsQuery } from "@/lib/settings";

/** The opt-in for aliases created by the first mail to a new address on the user's subdomain. */
export const OnTheFlySetting = ({ subdomains }: { readonly subdomains: ReadonlyArray<string> }) => {
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery);
  const update = useMutation({
    mutationFn: setOnTheFly,
    onSuccess: (stored) => queryClient.setQueryData(settingsQuery.queryKey, stored),
  });

  return Option.match(Arr.head(subdomains), {
    onNone: () => null,
    onSome: (subdomain) => (
      <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
        <div className="flex flex-col gap-0.5">
          <span id="on-the-fly-label" className="font-medium">
            Create aliases on the fly
          </span>
          <span id="on-the-fly-description" className="text-xs text-muted-foreground">
            Mail to any new address on <span className="data">{subdomain}</span> creates that alias
            and is forwarded. Off, it is dropped until you create the alias here.
          </span>
          {update.isError && (
            <span role="alert" className="text-xs text-destructive">
              Couldn't save the setting. Please try again.
            </span>
          )}
        </div>
        <Switch
          aria-labelledby="on-the-fly-label"
          aria-busy={!settings.isSuccess || update.isPending}
          aria-describedby="on-the-fly-description"
          checked={settings.data?.isOnTheFlyEnabled ?? false}
          disabled={!settings.isSuccess || update.isPending}
          onCheckedChange={(isEnabled) => update.mutate(isEnabled)}
        />
      </div>
    ),
  });
};
