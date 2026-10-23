import type { Recipient, UsernameView } from "@alias/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { AtSignIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { LoadFailed, Problem, SkeletonRows } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { recipientsQuery } from "@/lib/recipients";
import { setUsernameDestination, setUsernameOnTheFly, usernamesQuery } from "@/lib/usernames";
import { useRefreshUsernames } from "./refresh";

/** The select's value for "the account's default destination". */
const ACCOUNT_DEFAULT = "default";

/** Where a username's aliases forward: the account's default, or one verified destination. */
const Destination = ({
  entry,
  recipients,
}: {
  readonly entry: UsernameView;
  readonly recipients: ReadonlyArray<Recipient>;
}) => {
  const refresh = useRefreshUsernames();
  const change = useMutation({
    mutationFn: (recipientId: Option.Option<string>) =>
      setUsernameDestination(entry.username, recipientId),
    onSettled: refresh,
  });
  const verified = Arr.filter(recipients, (recipient) => recipient.isVerified);
  const items = [
    { value: ACCOUNT_DEFAULT, label: "Account default" },
    ...Arr.map(verified, (recipient) => ({ value: recipient.id, label: recipient.address })),
  ];
  if (entry.isPrimary) {
    return <span className="text-muted-foreground">Account default</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      <Select
        value={Option.getOrElse(entry.defaultRecipientId, () => ACCOUNT_DEFAULT)}
        items={items}
        disabled={change.isPending}
        onValueChange={(value) =>
          change.mutate(
            Option.filter(Option.liftPredicate(value, P.isString), (id) => id !== ACCOUNT_DEFAULT),
          )
        }
      >
        <SelectTrigger size="sm" aria-label={`Destination for ${entry.username}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectItem value={ACCOUNT_DEFAULT}>Account default</SelectItem>
          {Arr.isReadonlyArrayNonEmpty(verified) && <SelectSeparator />}
          {Arr.map(verified, (recipient) => (
            <SelectItem key={recipient.id} value={recipient.id} className="data">
              {recipient.address}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Problem error={change.error} />
    </div>
  );
};

const UsernameRow = ({
  entry,
  recipients,
  onDelete,
}: {
  readonly entry: UsernameView;
  readonly recipients: ReadonlyArray<Recipient>;
  readonly onDelete: () => void;
}) => {
  const refresh = useRefreshUsernames();
  const toggle = useMutation({
    mutationFn: (isEnabled: boolean) => setUsernameOnTheFly(entry.username, isEnabled),
    onSettled: refresh,
  });
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2 pl-1">
          <span className="data">{entry.username}</span>
          {entry.isPrimary && <Badge variant="secondary">Primary</Badge>}
        </div>
        <Problem error={toggle.error} />
      </TableCell>
      <TableCell>
        <div className="flex flex-col">
          {Arr.map(entry.subdomains, (subdomain) => (
            <span key={subdomain} className="data text-muted-foreground">
              {subdomain}
            </span>
          ))}
        </div>
      </TableCell>
      <TableCell>
        <Destination entry={entry} recipients={recipients} />
      </TableCell>
      <TableCell>
        <Switch
          size="sm"
          aria-label={`Create aliases on the fly on ${entry.username}`}
          aria-busy={toggle.isPending}
          checked={entry.isOnTheFlyEnabled}
          disabled={toggle.isPending}
          onCheckedChange={(isEnabled) => toggle.mutate(isEnabled)}
        />
      </TableCell>
      <TableCell>
        <div className="flex justify-end pr-1">
          {!entry.isPrimary && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Delete ${entry.username}`}
              onClick={onDelete}
            >
              <Trash2Icon />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
};

/**
 * The user's usernames (PLAN.md §20.34): the primary one they sign in with and the additional
 * ones, each a subdomain with its own on-the-fly switch and destination.
 */
export const UsernamesCard = ({
  onAdd,
  onDelete,
}: {
  readonly onAdd: () => void;
  readonly onDelete: (username: string) => void;
}) => {
  const usernames = useQuery(usernamesQuery);
  const recipients = useQuery(recipientsQuery);
  const additional = Arr.length(
    Arr.filter(usernames.data?.usernames ?? [], (entry) => !entry.isPrimary),
  );
  const isFull = usernames.isSuccess && additional >= usernames.data.limit;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AtSignIcon className="size-4 text-muted-foreground" aria-hidden />
          Usernames
        </CardTitle>
        <CardDescription>
          Each username is a subdomain where you pick the addresses. Add up to{" "}
          <span className="data">{usernames.data?.limit ?? "–"}</span> more to keep aliases apart;
          you always sign in with your primary one.
        </CardDescription>
        <CardAction>
          <Button variant="outline" disabled={!usernames.isSuccess || isFull} onClick={onAdd}>
            <PlusIcon />
            Add username
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {usernames.isError ? (
          <LoadFailed what="your usernames" onRetry={() => void usernames.refetch()} />
        ) : (
          <div className="overflow-hidden rounded-lg border bg-muted">
            <Table aria-label="Usernames" aria-busy={usernames.isPending}>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <span className="pl-1">Username</span>
                  </TableHead>
                  <TableHead>Subdomains</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>On the fly</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usernames.isPending ? (
                  <SkeletonRows columns={5} />
                ) : (
                  Arr.map(usernames.data.usernames, (entry) => (
                    <UsernameRow
                      key={entry.username}
                      entry={entry}
                      recipients={recipients.data ?? []}
                      onDelete={() => onDelete(entry.username)}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
