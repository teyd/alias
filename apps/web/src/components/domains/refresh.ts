import { useQueryClient } from "@tanstack/react-query";
import { aliasesQuery, domainsQuery } from "@/lib/aliases";
import { customDomainsQuery } from "@/lib/domains";

/** After a domain changes: its list, the domains aliases may use, and the aliases themselves. */
export const useRefreshDomains = () => {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: customDomainsQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: domainsQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: aliasesQuery.queryKey }),
    ]);
};
