import type { Settings } from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import { callApi } from "./api";

export const settingsQuery = queryOptions({
  queryKey: ["settings"],
  queryFn: () => callApi((api) => api.settings.get()),
});

/** Changes only the settings given and returns all of them as stored. */
export const updateSettings = (payload: Partial<Settings>) =>
  callApi((api) => api.settings.update({ payload }));
