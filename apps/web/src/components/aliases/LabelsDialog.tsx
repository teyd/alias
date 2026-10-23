import { type LabelColor, LabelColor as LabelColors } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { LabelDot } from "@/components/aliases/LabelBadge";
import { LoadFailed, Problem } from "@/components/states";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { labelsQuery, setLabelColor } from "@/lib/aliases";

const NONE = "none";
const isColor = Schema.is(LabelColors);

/** The user's labels with a colour picker each; `?dialog=labels` holds it open. */
export const LabelsDialog = ({
  isOpen,
  onClose,
}: {
  readonly isOpen: boolean;
  readonly onClose: () => void;
}) => {
  const labels = useQuery({ ...labelsQuery, enabled: isOpen });
  const queryClient = useQueryClient();
  const recolor = useMutation({
    mutationFn: ({ name, color }: { name: string; color: Option.Option<LabelColor> }) =>
      setLabelColor(name, color),
    onSettled: () => queryClient.invalidateQueries({ queryKey: labelsQuery.queryKey }),
  });

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Labels</DialogTitle>
          <DialogDescription>
            Give your labels a colour. Add or remove labels by editing an alias.
          </DialogDescription>
        </DialogHeader>
        {labels.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : labels.isError ? (
          <LoadFailed what="your labels" onRetry={() => void labels.refetch()} />
        ) : (
          Arr.match(labels.data, {
            onEmpty: () => (
              <p className="text-sm text-muted-foreground">
                No labels yet. Edit an alias to give it some.
              </p>
            ),
            onNonEmpty: (all) => (
              <ul aria-label="Labels" className="flex flex-col gap-2">
                {Arr.map(all, (label) => (
                  <li key={label.name} className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">{label.name}</span>
                      <span className="text-xs text-muted-foreground">
                        <span className="data">{label.aliasCount}</span> aliases
                      </span>
                    </span>
                    <Select
                      value={Option.getOrElse(label.color, () => NONE)}
                      disabled={recolor.isPending}
                      onValueChange={(value) =>
                        recolor.mutate({
                          name: label.name,
                          color: isColor(value) ? Option.some(value) : Option.none(),
                        })
                      }
                    >
                      <SelectTrigger aria-label={`Colour of ${label.name}`} className="w-32">
                        <SelectValue>
                          {(value: string) => (value === NONE ? "No colour" : value)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent alignItemWithTrigger={false}>
                        <SelectItem value={NONE}>No colour</SelectItem>
                        {Arr.map(LabelColors.literals, (color) => (
                          <SelectItem key={color} value={color}>
                            <LabelDot color={color} />
                            {color}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </li>
                ))}
              </ul>
            ),
          })
        )}
        <Problem error={recolor.error} />
      </DialogContent>
    </Dialog>
  );
};
