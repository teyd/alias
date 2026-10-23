import type { Rule } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ArrowDownIcon, ArrowUpIcon, ListFilterIcon, PlusIcon } from "lucide-react";
import { Page } from "@/components/Page";
import { RuleEditor } from "@/components/rules/RuleEditor";
import { SampleTester } from "@/components/rules/SampleTester";
import { describeAction, describeCondition } from "@/components/rules/labels";
import { EmptyState, LoadFailed, Problem } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { callRules, rulesQuery } from "@/lib/rules";

const Search = Schema.Struct({
  dialog: Schema.optionalKey(Schema.Literal("new")),
  /** The rule whose editor is open. */
  edit: Schema.optionalKey(Schema.String),
});

/** `ids` with the one at `from` moved to `to`. */
const moved = (ids: ReadonlyArray<string>, from: number, to: number) =>
  Option.match(Arr.get(ids, from), {
    onNone: () => ids,
    onSome: (id) => Arr.insertAt(Arr.remove(ids, from), to, id).pipe(Option.getOrElse(() => ids)),
  });

const RuleRow = ({
  rule,
  index,
  ids,
  onEdit,
}: {
  readonly rule: Rule;
  readonly index: number;
  readonly ids: ReadonlyArray<string>;
  readonly onEdit: () => void;
}) => {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: rulesQuery.queryKey });
  const toggle = useMutation({
    mutationFn: (isEnabled: boolean) =>
      callRules((api) =>
        api.rules.update({
          params: { ruleId: rule.id },
          payload: { ...Struct.omit(rule, ["id"]), isEnabled },
        }),
      ),
    onSettled: refresh,
  });
  const move = useMutation({
    mutationFn: (to: number) =>
      callRules((api) => api.rules.reorder({ payload: { ruleIds: moved(ids, index, to) } })),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => callRules((api) => api.rules.remove({ params: { ruleId: rule.id } })),
    onSettled: refresh,
  });
  const isBusy = toggle.isPending || move.isPending || remove.isPending;
  const joiner = rule.match === "all" ? " and " : " or ";
  return (
    <li aria-label={rule.name} className="flex flex-col gap-2 bg-card p-3">
      <div className="flex items-start gap-3">
        <span className="data pt-0.5 text-xs text-muted-foreground">{index + 1}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2">
            <span className={rule.isEnabled ? "font-medium" : "text-muted-foreground"}>
              {rule.name}
            </span>
            {!rule.isEnabled && <Badge variant="secondary">Off</Badge>}
          </span>
          <span className="text-xs text-muted-foreground">
            When {Arr.join(Arr.map(rule.conditions, describeCondition), joiner)}:{" "}
            {Arr.join(Arr.map(rule.actions, describeAction), ", ")}.
          </span>
        </div>
        <Switch
          aria-label={`${rule.name} enabled`}
          checked={rule.isEnabled}
          disabled={isBusy}
          onCheckedChange={(isEnabled) => toggle.mutate(isEnabled)}
        />
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${rule.name} up`}
            disabled={isBusy || index === 0}
            onClick={() => move.mutate(index - 1)}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${rule.name} down`}
            disabled={isBusy || index === ids.length - 1}
            onClick={() => move.mutate(index + 1)}
          >
            <ArrowDownIcon />
          </Button>
          <Button variant="outline" size="sm" disabled={isBusy} onClick={onEdit}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" disabled={isBusy} onClick={() => remove.mutate()}>
            Delete
          </Button>
        </div>
      </div>
      <Problem error={toggle.error ?? move.error ?? remove.error} />
    </li>
  );
};

/** The owner's ordered rules (PLAN.md §20.32) and a tester for them. */
const RulesScreen = () => {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const rules = useQuery(rulesQuery);
  const openNew = () =>
    void navigate({ search: (current) => ({ ...current, dialog: "new" }), replace: true });
  const openEdit = (ruleId: string) =>
    void navigate({ search: (current) => ({ ...current, edit: ruleId }), replace: true });
  const close = () =>
    void navigate({ search: (current) => Struct.omit(current, ["dialog", "edit"]), replace: true });
  const editing = Option.fromUndefinedOr(search.edit).pipe(
    Option.flatMap((ruleId) => Arr.findFirst(rules.data ?? [], (rule) => rule.id === ruleId)),
  );
  const ids = Arr.map(rules.data ?? [], (rule) => rule.id);
  const newRule = (
    <Button onClick={openNew}>
      <PlusIcon />
      New rule
    </Button>
  );

  return (
    <Page title="Rules" actions={newRule}>
      <p className="text-muted-foreground">
        Rules act on mail to every alias, top to bottom. A rule that blocks stops the ones below it.
        Replies you send are only ever blocked, never changed.
      </p>
      {rules.isError ? (
        <LoadFailed what="your rules" onRetry={() => void rules.refetch()} />
      ) : rules.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        Arr.match(rules.data, {
          onEmpty: () => (
            <EmptyState icon={<ListFilterIcon />} title="No rules yet" action={newRule}>
              Tag, reroute or block mail by its sender, subject or alias.
            </EmptyState>
          ),
          onNonEmpty: (rows) => (
            <ul
              aria-label="Rules"
              className="flex flex-col gap-px overflow-hidden rounded-lg border bg-border"
            >
              {Arr.map(rows, (rule, index) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  index={index}
                  ids={ids}
                  onEdit={() => openEdit(rule.id)}
                />
              ))}
            </ul>
          ),
        })
      )}
      <Card>
        <CardHeader>
          <CardTitle>Try a message</CardTitle>
          <CardDescription>
            See what your blocklist and rules would do with it. Nothing is sent or stored.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SampleTester rules={rules.data ?? []} />
        </CardContent>
      </Card>
      <RuleEditor
        isOpen={search.dialog === "new" || Option.isSome(editing)}
        rule={editing}
        onOpenChange={(isOpen) => (isOpen ? undefined : close())}
      />
    </Page>
  );
};

export const Route = createFileRoute("/_app/rules")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  component: RulesScreen,
});
