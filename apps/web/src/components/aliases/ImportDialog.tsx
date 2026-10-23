import { AliasCsv } from "@alias/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Problem } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  aliasesQuery,
  csvProblems,
  importAliases,
  importProblems,
  labelsQuery,
} from "@/lib/aliases";

/** The file couldn't be read as CSV. */
class UnreadableFile extends Schema.TaggedError<UnreadableFile>()("UnreadableFile", {
  message: Schema.String,
}) {}

const importFile = (file: File) =>
  file.text().then((text) =>
    Result.match(AliasCsv.parse(text), {
      onFailure: (error) =>
        Promise.reject(new UnreadableFile({ message: csvProblems[error.reason] })),
      onSuccess: (rows) =>
        Arr.isReadonlyArrayEmpty(rows)
          ? Promise.reject(new UnreadableFile({ message: "That file lists no addresses." }))
          : importAliases(rows),
    }),
  );

/**
 * Creates aliases from a CSV file on the user's subdomain and custom domains (PLAN.md §20.31),
 * then says what became of each row. `?dialog=import` holds it open.
 */
export const ImportDialog = ({
  isOpen,
  onClose,
}: {
  readonly isOpen: boolean;
  readonly onClose: () => void;
}) => {
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: importFile,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: aliasesQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: labelsQuery.queryKey }),
      ]),
  });
  const results = run.data ?? [];
  const created = Arr.length(Arr.filter(results, (result) => P.isTagged(result, "Created")));

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (open) return;
        run.reset();
        onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import aliases</DialogTitle>
          <DialogDescription>
            A CSV file with an “address” column, and optionally “description”, “labels” (separated
            by “;”) and “active”: an export imports again. Addresses must be on your subdomain or
            your verified custom domains.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="import-file">CSV file</FieldLabel>
          <Input
            id="import-file"
            type="file"
            accept=".csv,text/csv"
            disabled={run.isPending}
            onChange={(event) => {
              const file = event.target.files?.item(0);
              if (file !== null && file !== undefined) run.mutate(file);
              event.target.value = "";
            }}
          />
          <FieldDescription>Choosing a file imports it.</FieldDescription>
        </Field>
        {run.isPending && <p className="text-sm text-muted-foreground">Importing…</p>}
        <Problem error={run.error} />
        {Arr.isReadonlyArrayNonEmpty(results) && (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              <span className="data">{created}</span> of{" "}
              <span className="data">{Arr.length(results)}</span> created.
            </p>
            <ul aria-label="Import results" className="flex max-h-72 flex-col gap-1 overflow-auto">
              {Arr.map(results, (result) => (
                <li key={result.row} className="flex items-start gap-2 text-sm">
                  <span className="data w-10 shrink-0 text-muted-foreground">{result.row}</span>
                  {P.isTagged(result, "Created") ? (
                    <>
                      <span className="data min-w-0 flex-1 truncate">{result.alias.address}</span>
                      <Badge variant="success">Created</Badge>
                    </>
                  ) : (
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="data truncate">{result.address}</span>
                      <span className="text-destructive">{importProblems[result.reason]}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
