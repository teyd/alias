import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AliasList } from "@/components/AliasList";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/api";
import { meQuery } from "@/lib/session";

const Home = () => {
  const me = useQuery(meQuery);
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
      {Option.isSome(me.data ?? Option.none()) && <AliasList />}
    </>
  );
};

export const Route = createFileRoute("/")({ component: Home });
