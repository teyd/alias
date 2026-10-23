import { OAuth, WebhookUrl } from "@alias/core";
import { OAuthRepo } from "@alias/db";
import { UrlPolicy } from "@alias/webhooks";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

/** A client as the authorization server knows it, however it got its `client_id`. */
export interface Client {
  readonly id: string;
  readonly name: string;
  readonly kind: "registered" | "metadata-document";
  readonly uri: Option.Option<string>;
  readonly redirectUris: ReadonlyArray<string>;
}

/** No such client: never registered here, and not a metadata document URL. */
class UnknownClient extends Schema.TaggedError<UnknownClient>()("UnknownClient", {}) {}

/** The client's metadata document can't be fetched, or isn't a valid one. */
class ClientMetadataUnavailable extends Schema.TaggedError<ClientMetadataUnavailable>()(
  "ClientMetadataUnavailable",
  { reason: Schema.String },
) {}

/** A metadata document is small; anything bigger isn't one. */
const MAX_DOCUMENT_BYTES = 5 * 1024;
const FETCH_TIMEOUT = Duration.seconds(5);

/**
 * draft-ietf-oauth-client-id-metadata-document-00 §4: the client's own metadata, RFC 7591 names.
 * Only what the authorization server uses is read.
 */
const MetadataDocument = Schema.fromJsonString(
  Schema.Struct({
    client_id: Schema.String,
    client_name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
    client_uri: Schema.optionalKey(Schema.String),
    redirect_uris: Schema.NonEmptyArray(Schema.String).check(Schema.isMaxLength(10)),
    token_endpoint_auth_method: Schema.optionalKey(Schema.String),
  }),
);
const decodeDocument = Schema.decodeUnknownEffect(MetadataDocument);

const unavailable = (reason: string) => Effect.fail(new ClientMetadataUnavailable({ reason }));

/**
 * A URL-formatted `client_id` (Client ID Metadata Documents, MCP's recommended registration):
 * fetch the document it names and check it describes itself. The fetch goes through `Egress`,
 * the same SSRF guard webhooks use, so the URL must be `https:` on a public host (loopback only in
 * tests and dev) and every address it resolves to public; redirects are not followed.
 */
const fromMetadataDocument = Effect.fn("Clients.fromMetadataDocument")(function* (url: URL) {
  const client = yield* HttpClient.HttpClient;
  const id = url.href;
  const text = yield* Effect.gen(function* () {
    const response = yield* HttpClient.withScope(client).execute(
      HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson),
    );
    if (response.status !== 200) return yield* unavailable(`status ${response.status}`);
    if (Number(response.headers["content-length"] ?? 0) > MAX_DOCUMENT_BYTES) {
      return yield* unavailable("too large");
    }
    // Read with a cap, not `response.text`: a chunked answer names no length, and the host is
    // the requester's, so it could stream until the Lambda runs out of memory (PLAN.md §20.25).
    const chunks = yield* Stream.runFoldEffect(
      response.stream,
      () => ({ size: 0, chunks: Arr.empty<Uint8Array>() }),
      (read, chunk) =>
        read.size + chunk.length > MAX_DOCUMENT_BYTES
          ? unavailable("too large")
          : Effect.succeed({ size: read.size + chunk.length, chunks: [...read.chunks, chunk] }),
    );
    return new TextDecoder().decode(Uint8Array.from(Arr.flatMap(chunks.chunks, (c) => [...c])));
  }).pipe(
    Effect.timeoutOrElse({ duration: FETCH_TIMEOUT, orElse: () => unavailable("timed out") }),
    Effect.catchTag("HttpClientError", () => unavailable("unreachable")),
    Effect.scoped,
  );
  if (text.length > MAX_DOCUMENT_BYTES) return yield* unavailable("too large");
  const document = yield* decodeDocument(text).pipe(
    Effect.catchTag("SchemaError", () => unavailable("not a client metadata document")),
  );
  if (document.client_id !== id) return yield* unavailable("client_id differs from its URL");
  // Public clients only: there is nothing to authenticate a confidential one with.
  if (
    document.token_endpoint_auth_method !== undefined &&
    document.token_endpoint_auth_method !== "none"
  ) {
    return yield* unavailable("only token_endpoint_auth_method none is supported");
  }
  if (!Arr.every(document.redirect_uris, OAuth.isAllowedRedirectUri)) {
    return yield* unavailable("redirect URIs must be https or loopback http");
  }
  return {
    id,
    name: Option.getOrElse(Option.fromUndefinedOr(document.client_name), () => url.host),
    kind: "metadata-document",
    uri: Option.fromUndefinedOr(document.client_uri),
    redirectUris: document.redirect_uris,
  } satisfies Client;
});

/** A URL-formatted `client_id` names a metadata document; any other one, a registered client. */
export const isMetadataDocumentId = (clientId: string) =>
  Str.startsWith("https://")(clientId) || Str.startsWith("http://")(clientId);

/**
 * The client a `client_id` names: one registered here (RFC 7591), or the metadata document at a
 * URL-formatted one. A URL that isn't allowed to be fetched is an unknown client.
 */
export const resolve = Effect.fn("Clients.resolve")(function* (clientId: string) {
  if (isMetadataDocumentId(clientId)) {
    const policy = yield* UrlPolicy.UrlPolicy;
    const url = WebhookUrl.check(clientId, policy);
    // The draft requires a path component: `https://example.com/` names no document.
    if (Result.isFailure(url) || url.success.pathname === "/") return yield* new UnknownClient();
    return yield* fromMetadataDocument(url.success);
  }
  const repo = yield* OAuthRepo.OAuthRepo;
  const registered = yield* Effect.orDie(repo.findClient(clientId));
  if (Option.isNone(registered)) return yield* new UnknownClient();
  return {
    id: registered.value.id,
    name: registered.value.name,
    kind: "registered",
    uri: registered.value.uri,
    redirectUris: registered.value.redirectUris,
  } satisfies Client;
});
