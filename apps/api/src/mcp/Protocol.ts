import * as Arr from "effect/Array";
import { Base64 } from "effect/encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * The slice of the Model Context Protocol this server speaks (PLAN.md §20.24), parsed with Schema
 * at the boundary. Dual-era: revision 2026-07-28 ("modern": no handshake, version and client
 * capabilities in every request's `_meta`), and, for clients that still open with `initialize`,
 * the revisions 2025-03-26 to 2025-11-25 ("legacy"), served without sessions, which those
 * revisions allow.
 */

const MODERN_VERSIONS = ["2026-07-28"];
/** Newest first: an `initialize` asking for anything else is answered with the first. */
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

export const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  serverInfo: "io.modelcontextprotocol/serverInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
} as const;

/** JSON-RPC 2.0 and MCP error codes (2026-07-28 "Error codes"). */
export const ErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Implementation-defined range: the token lacks a scope (the HTTP answer is 403). */
  insufficientScope: -32001,
  headerMismatch: -32020,
  unsupportedProtocolVersion: -32022,
} as const;

const Id = Schema.Union([Schema.String, Schema.Number]);
export type Id = typeof Id.Type;

const Params = Schema.Record(Schema.String, Schema.Json);

/** A request (with `id`) or a notification. Responses from clients are refused (Streamable HTTP). */
export const Message = Schema.fromJsonString(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.optionalKey(Id),
    method: Schema.String,
    params: Schema.optionalKey(Params),
  }),
);
export type Message = typeof Message.Type;

/** What a request's `_meta` says about its client. */
const RequestMeta = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Struct({
      [META.protocolVersion]: Schema.optionalKey(Schema.String),
    }),
  ),
});

/** The protocol version a modern request declares in `_meta`, if it declares one. */
export const declaredVersion = (params: Message["params"]): Option.Option<string> =>
  Option.flatMap(Schema.decodeUnknownOption(RequestMeta)(params ?? {}), (meta) =>
    Option.fromUndefinedOr(meta._meta?.[META.protocolVersion]),
  );

/** The capability a URL-mode elicitation needs (2026-07-28 "Elicitation", in `_meta`). */
const UrlElicitation = Schema.Struct({
  _meta: Schema.Struct({
    [META.clientCapabilities]: Schema.Struct({
      elicitation: Schema.Struct({ url: Schema.Json }),
    }),
  }),
});

/** True when the request's client can open a URL for its user (modern clients only). */
export const canOpenUrl = (params: Message["params"]): boolean =>
  Option.isSome(Schema.decodeUnknownOption(UrlElicitation)(params ?? {}));

/** The user's answer to the `approve` input request, on an MRTR retry (2026-07-28). */
export const Approval = Schema.Struct({
  approve: Schema.Struct({ action: Schema.Literals(["accept", "decline", "cancel"]) }),
});
export type Approval = typeof Approval.Type;

export const InitializeParams = Schema.Struct({ protocolVersion: Schema.String });
export type InitializeParams = typeof InitializeParams.Type;

export const CallToolParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Params),
  /** MRTR (2026-07-28): answers to the input requests of an earlier `input_required` result. */
  inputResponses: Schema.optionalKey(Params),
  /** MRTR: echoed from the earlier `input_required` result, attacker-controlled. */
  requestState: Schema.optionalKey(Schema.String),
});
export type CallToolParams = typeof CallToolParams.Type;

const BASE64_SENTINEL = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/;

/**
 * A mirrored header value (`Mcp-Name`, `Mcp-Param-*`) as the body holds it: plain, or the
 * `=?base64?…?=` sentinel form clients use for values that aren't plain ASCII (Streamable HTTP,
 * "Value Encoding").
 */
export const headerValue = (raw: string): string =>
  Option.match(Option.fromNullOr(BASE64_SENTINEL.exec(raw)), {
    onNone: () => raw,
    onSome: (match) =>
      Result.match(Base64.decode(match[1] ?? ""), {
        onFailure: () => raw,
        onSuccess: (bytes) => new TextDecoder().decode(bytes),
      }),
  });

/** True for a version this server serves without a handshake. */
export const isModern = (version: string) => Arr.contains(MODERN_VERSIONS, version);

/** True for a version this server serves after `initialize`. */
export const isLegacy = (version: string) => Arr.contains(LEGACY_VERSIONS, version);
