import { queryOptions } from "@tanstack/react-query";
import { callApi } from "./api";

export const settingsQuery = queryOptions({
  queryKey: ["settings"],
  queryFn: () => callApi((api) => api.settings.get()),
});

export const setOnTheFly = (isOnTheFlyEnabled: boolean) =>
  callApi((api) => api.settings.update({ payload: { isOnTheFlyEnabled } }));
