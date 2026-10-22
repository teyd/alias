import { DeviceCodeNotFound, TooManyAttempts } from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type Client, callApi } from "./api";

/** Why a device login step failed, worded for the person at the keyboard. */
class DeviceActionFailed extends Schema.TaggedError<DeviceActionFailed>()("DeviceActionFailed", {
  message: Schema.String,
}) {}

const describe = <E>(error: E): string => {
  if (error instanceof DeviceCodeNotFound) {
    return "No sign-in is waiting for that code. It may have expired (codes last 10 minutes) or been used already: start again on your device.";
  }
  if (error instanceof TooManyAttempts) return "Too many wrong codes. Try again in an hour.";
  return "Something went wrong. Please try again.";
};

/** Runs one device-login call, replacing every failure with a readable message. */
export const callDevice = <A, E>(call: (api: Client) => Effect.Effect<A, E>): Promise<A> =>
  callApi((api) =>
    Effect.mapError(call(api), (error) => new DeviceActionFailed({ message: describe(error) })),
  );

export const deviceRequestQuery = (userCode: string) =>
  queryOptions({
    queryKey: ["device", userCode],
    queryFn: () => callDevice((api) => api.device.lookup({ payload: { userCode } })),
    retry: false,
  });
