import { useQueryClient } from "@tanstack/react-query";
import { aliasesQuery, domainsQuery } from "@/lib/aliases";
import { settingsQuery } from "@/lib/settings";
import { usernamesQuery } from "@/lib/usernames";

/**
 * After a username changes: the list, the domains aliases may use, the aliases (a deleted one
 * takes its aliases along) and the settings (the primary's on-the-fly switch is the account's).
 */
export const useRefreshUsernames = () => {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: usernamesQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: domainsQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: aliasesQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey }),
    ]);
};
