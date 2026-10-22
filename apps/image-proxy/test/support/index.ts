import * as Layer from "effect/Layer";
import { Egress } from "../../src/index.ts";

export { origin, PNG } from "./Origin.ts";

/**
 * Egress to 127.0.0.1 only, on any port: what tests need to reach a local origin. Production's
 * policy (`Egress.publicInternet`) refuses loopback, and is tested as such.
 */
export const onlyLoopback = Layer.succeed(Egress.EgressPolicy, {
  isAllowedAddress: (address) => address === "127.0.0.1",
  isAllowedPort: () => true,
});
