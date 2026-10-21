import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/api";

const Home = () => {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => callApi((api) => api.system.health()),
  });

  return (
    <section className="mt-4 flex items-center gap-4">
      <p className="text-sm text-muted-foreground">
        API: {health.isPending ? "checking…" : health.isError ? "unreachable" : health.data.status}
      </p>
      <Button variant="outline" size="sm" onClick={() => health.refetch()}>
        Recheck
      </Button>
    </section>
  );
};

export const Route = createFileRoute("/")({ component: Home });
