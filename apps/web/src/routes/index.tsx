import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AliasList } from "@/components/AliasList";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/api";
import { meQuery } from "@/lib/session";

/** Which alias shows its contacts, so the open panel survives a reload and can be linked. */
const Search = Schema.Struct({ contacts: Schema.optionalKey(Schema.String) });

const Home = () => {
  const me = useQuery(meQuery);
  const search = Route.useSearch();
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => callApi((api) => api.system.health()),
  });

  return (
    <>
      <section className="mt-4 flex items-center gap-4">
        <p className="text-sm text-muted-foreground">
          API:{" "}
          {health.isPending ? "checking…" : health.isError ? "unreachable" : health.data.status}
        </p>
        <Button variant="outline" size="sm" onClick={() => health.refetch()}>
          Recheck
        </Button>
      </section>
      {Option.isSome(me.data ?? Option.none()) && (
        <AliasList openContacts={Option.fromUndefinedOr(search.contacts)} />
      )}
    </>
  );
};

export const Route = createFileRoute("/")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  component: Home,
});
