import type { AliasView, Label } from "@alias/contracts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BanIcon,
  CircleCheckIcon,
  EllipsisIcon,
  PencilIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { LabelBadge } from "@/components/aliases/LabelBadge";
import { CopyButton } from "@/components/CopyButton";
import { Problem } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableRow } from "@/components/ui/table";
import { aliasesQuery, setActive } from "@/lib/aliases";

/**
 * One alias: its description and labels, counters, contacts, the active switch, and
 * edit/deactivate/delete in its menu.
 */
export const AliasRow = ({
  alias,
  labels,
  onContacts,
  onEdit,
  onDelete,
}: {
  readonly alias: AliasView;
  /** The user's labels, for their colours. */
  readonly labels: ReadonlyArray<Label>;
  readonly onContacts: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) => {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (isActive: boolean) => setActive(alias.address, isActive),
    onSettled: () => queryClient.invalidateQueries({ queryKey: aliasesQuery.queryKey }),
  });
  const tone = alias.isActive ? "" : "text-muted-foreground";

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-1 pl-2">
          <span className={`data ${tone}`}>{alias.address}</span>
          <CopyButton text={alias.address} label="Copy address" />
        </div>
        {Option.match(alias.description, {
          onNone: () => null,
          onSome: (description) => (
            <p className="max-w-md truncate pl-2 text-xs text-muted-foreground">{description}</p>
          ),
        })}
        {Arr.isReadonlyArrayNonEmpty(alias.labels) && (
          <div className="flex flex-wrap gap-1 pt-1 pl-2">
            {Arr.map(alias.labels, (label) => (
              <LabelBadge key={label} name={label} labels={labels} />
            ))}
          </div>
        )}
        <Problem error={toggle.error} />
      </TableCell>
      <TableCell className={`data text-right ${tone}`}>{alias.forwardedCount}</TableCell>
      <TableCell className={`data text-right ${tone}`}>{alias.blockedCount}</TableCell>
      <TableCell>
        <Button variant="ghost" size="xs" onClick={onContacts}>
          <UsersIcon />
          Contacts
        </Button>
      </TableCell>
      <TableCell>
        <Switch
          size="sm"
          aria-label="Active"
          checked={alias.isActive}
          disabled={toggle.isPending}
          onCheckedChange={(isActive) => toggle.mutate(isActive)}
        />
      </TableCell>
      <TableCell>
        <div className="flex justify-end pr-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label="Alias actions" />}
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-60">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="data">{alias.address}</DropdownMenuLabel>
                <DropdownMenuItem onClick={onEdit}>
                  <PencilIcon />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => toggle.mutate(!alias.isActive)}>
                  {alias.isActive ? <BanIcon /> : <CircleCheckIcon />}
                  {alias.isActive ? "Deactivate" : "Activate"}
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );
};
