import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import request from "../fixtures/sesv2-send-email-request.json" with { type: "json" };
import response from "../fixtures/sesv2-send-email-response.json" with { type: "json" };
import { Transport } from "../src/index.ts";

const readRawMessage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFile(
    yield* path.fromFileUrl(new URL("../fixtures/sesv2-raw-message.eml", import.meta.url)),
  );
}).pipe(
  // NodeFileSystem returns a Buffer, which never deep-equals a plain Uint8Array.
  Effect.map((bytes) => new Uint8Array(bytes)),
  Effect.provide(NodeServices.layer),
);

describe("Transport (contract: AWS documentation payloads)", () => {
  it.effect("decodes the documented SendEmail response to its message ID", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknownEffect(Transport.SendEmailResult)(response);
      expect(result.MessageId).toBe("EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000");
    }),
  );

  it.effect("rejects a response without a message ID", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Schema.decodeUnknownEffect(Transport.SendEmailResult)({}));
      expect(error._tag).toBe("SchemaError");
    }),
  );

  it.effect("carries the documented raw message as base64 in Content.Raw.Data", () =>
    Effect.gen(function* () {
      const data = yield* Schema.decodeUnknownEffect(Schema.Uint8ArrayFromBase64)(
        request.Content.Raw.Data,
      );
      expect(data).toEqual(yield* readRawMessage);
    }),
  );
});
