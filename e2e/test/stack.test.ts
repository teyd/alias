import { TestAuthenticator } from "@alias/api/testing";
import { Inbound, SesEvent, SnsEvent, Transport } from "@alias/aws";
import { Username, Webhook } from "@alias/core";
import { Dynamo } from "@alias/db";
import { DohServer } from "@alias/doh-emulator";
import * as ImageProxyTesting from "@alias/image-proxy/testing";
import { Feedback, Pipeline } from "@alias/inbound";
import { FunctionUrlServer, SnsSubscriber, SqsEventSource } from "@alias/lambda-emulator";
import { Receiver } from "@alias/webhooks/testing";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as SESV2 from "@distilled.cloud/aws/sesv2";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import {
  Client,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { apiHandler, layer, sentTo, smtp, smtpRaw, spoolBucket } from "./support/stack.ts";
import * as openpgp from "openpgp";

const origin = "https://alias.test";

/** The real API Lambda behind the function URL emulator. */
const stack = layer(
  Layer.unwrap(
    Effect.map(apiHandler({ id: "alias.test", origin }), (handler) =>
      FunctionUrlServer.layer({ handler }),
    ),
  ),
);

const call = (
  path: string,
  init: {
    readonly body?: Schema.Json;
    readonly cookie?: string;
    readonly bearer?: string;
    readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  } = {},
) =>
  Effect.gen(function* () {
    const { url } = yield* FunctionUrlServer.FunctionUrlServer;
    const headers = new Headers({ "content-type": "application/json", origin });
    if (init.cookie !== undefined) headers.set("cookie", init.cookie);
    if (init.bearer !== undefined) headers.set("authorization", `Bearer ${init.bearer}`);
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    const request: RequestInit = { method, headers };
    if (init.body !== undefined) request.body = JSON.stringify(init.body);
    const response = yield* Effect.promise(() => fetch(`${url}${path}`, request));
    const text = yield* Effect.promise(() => response.text());
    return {
      status: response.status,
      body: text === "" ? null : JSON.parse(text),
      cookies: response.headers.getSetCookie(),
    };
  });

/** An OAuth-style call (RFC 8628, RFC 7009): a form-encoded POST, as `alias login` sends it. */
const postForm = (path: string, fields: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const { url } = yield* FunctionUrlServer.FunctionUrlServer;
    const response = yield* Effect.promise(() =>
      fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      }),
    );
    const text = yield* Effect.promise(() => response.text());
    return {
      status: response.status,
      body: text === "" ? null : JSON.parse(text),
      cacheControl: response.headers.get("cache-control"),
    };
  });

/** Signs up with a fresh software passkey and returns the session cookie and user ID. */
const signUp = (username: string) =>
  Effect.gen(function* () {
    const authenticator = TestAuthenticator.make(origin);
    const started = yield* call("/v1/auth/register/options", { body: { username } });
    const registered = yield* call("/v1/auth/register", {
      body: {
        challengeId: started.body.challengeId,
        credential: authenticator.create(started.body.options),
      },
    });
    expect(registered.status).toBe(200);
    const cookie = (registered.cookies[0] ?? "").split(";")[0] ?? "";
    return { cookie, userId: String(registered.body.userId), authenticator };
  });

/**
 * `fetch` for an MCP client from outside: the public origin (`https://alias.test`, CloudFront in
 * production) is the function URL server here. Nothing else about the requests changes.
 */
const viaStack =
  (url: string): typeof fetch =>
  (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    expect(input).not.toBeInstanceOf(Request);
    return fetch(target.replace(origin, url), init);
  };

/** What an MCP host keeps for one server, as the official SDK asks it to. */
interface OAuthState {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  verifier: string;
  authorizationUrl?: URL;
}

/** An MCP client's OAuth state, in memory. */
const oauthClient = () => {
  const state: OAuthState = { verifier: "" };
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return "http://127.0.0.1:33418/callback";
    },
    get clientMetadata() {
      return {
        client_name: "SDK stack test",
        redirect_uris: ["http://127.0.0.1:33418/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      };
    },
    state: () => "stack-state",
    clientInformation: () => state.client,
    saveClientInformation: (client) => {
      state.client = client;
    },
    tokens: () => state.tokens,
    saveTokens: (tokens) => {
      state.tokens = tokens;
    },
    redirectToAuthorization: (url) => {
      state.authorizationUrl = url;
    },
    saveCodeVerifier: (verifier) => {
      state.verifier = verifier;
    },
    codeVerifier: () => state.verifier,
  };
  return { provider, state };
};

/**
 * The OAuth dance of the official MCP SDK client against the stack, as a host runs it: no token,
 * 401 → protected resource metadata → authorization server metadata → dynamic registration →
 * PKCE, the browser sent to the consent page, where the signed-in user (`cookie`) grants
 * `scopes`; then the redirect, whose `iss` the client checks before redeeming the code.
 * Returns a way to connect, as a 2026-07-28 (`auto`) or 2025 (`legacy`) client.
 */
const authorizeMcp = (cookie: string, scopes: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { url } = yield* FunctionUrlServer.FunctionUrlServer;
    const oauth = oauthClient();
    const transport = () =>
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        authProvider: oauth.provider,
        fetch: viaStack(url),
      });
    const refused = yield* Effect.promise(() =>
      new Client({ name: "stack-test", version: "1.0.0" }).connect(transport()).then(
        () => undefined,
        (error: Error) => error,
      ),
    );
    expect(refused).toBeInstanceOf(UnauthorizedError);
    const authorize = oauth.state.authorizationUrl ?? new URL("about:blank");
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${origin}/oauth/authorize`);
    const request = R.fromEntries(authorize.searchParams);
    expect(request).toMatchObject({
      response_type: "code",
      client_id: expect.stringMatching(/^mcp_/),
      code_challenge_method: "S256",
      redirect_uri: "http://127.0.0.1:33418/callback",
      resource: `${origin}/mcp`,
      state: "stack-state",
    });
    const shown = yield* call("/v1/oauth/authorization", { cookie, body: request });
    expect(shown.body.client).toMatchObject({ name: "SDK stack test", isLocalRedirect: true });
    const decided = yield* call("/v1/oauth/authorization/decision", {
      cookie,
      body: { request, isApproved: true, scopes: [...scopes] },
    });
    const back = new URL(decided.body.redirectTo);
    yield* Effect.promise(() => transport().finishAuth(back.searchParams));
    expect(oauth.state.tokens).toMatchObject({ token_type: "Bearer", scope: scopes.join(" ") });
    const connect = (mode: "auto" | "legacy", configure: (client: Client) => void = () => {}) =>
      Effect.promise(async () => {
        const client = new Client(
          { name: "stack-test", version: "1.0.0" },
          { versionNegotiation: { mode }, capabilities: { elicitation: { url: {} } } },
        );
        configure(client);
        await client.connect(transport());
        return client;
      });
    return { connect };
  });

/** Header fields of a raw message, unfolded, in order. */
const fields = (raw: string) =>
  Arr.map((raw.split("\r\n\r\n")[0] ?? "").replace(/\r\n[ \t]/g, " ").split("\r\n"), (line) => {
    const colon = line.indexOf(":");
    return { name: line.slice(0, colon).toLowerCase(), value: line.slice(colon + 1).trim() };
  });

const field = (raw: string, name: string) =>
  Option.map(
    Arr.findFirst(fields(raw), (found) => found.name === name),
    (found) => found.value,
  );

/**
 * A user as the web app creates one: a passkey account, a forwarding address confirmed with the
 * link from the mailed confirmation, and an alias on their own subdomain.
 */
const owner = (username: string, mailbox = `${username}@mailbox.example`) =>
  Effect.gen(function* () {
    const { cookie, userId, authenticator } = yield* signUp(username);
    const added = yield* call("/v1/recipients", { cookie, body: { address: mailbox } });
    expect(added.status).toBe(201);
    const [confirmation] = yield* sentTo(mailbox);
    const token = new URL(
      /https:\/\/alias\.test\/destinations\?\S+/.exec(confirmation?.text ?? "")?.[0] ?? "x:",
    ).searchParams.get("token");
    const confirmed = yield* call(`/v1/recipients/${added.body.id}/confirm`, {
      cookie,
      body: { token },
    });
    expect(confirmed.status).toBe(200);
    const alias = `shop@${username}.alias.test`;
    const created = yield* call("/v1/aliases", {
      cookie,
      body: { _tag: "Address", address: alias, mode: "forward" },
    });
    expect(created.status).toBe(201);
    // fakecloud only accepts senders on an exactly verified domain; AWS also accepts subdomains
    // of a verified one (PLAN.md §20.5), so the user's subdomain is verified explicitly.
    yield* Transport.ensureIdentity(`${username}.alias.test`);
    return { cookie, userId, authenticator, mailbox, alias };
  });

/** Every item in the shared table whose keys or values mention `text`, as JSON. */
const itemsMentioning = (text: string) =>
  Effect.gen(function* () {
    const table = yield* Dynamo.DynamoTable;
    const { Items } = yield* DynamoDB.scan({ TableName: table.name, ConsistentRead: true });
    return Arr.filter(Items ?? [], (item) => JSON.stringify(item).includes(text));
  });

const invoke = Pipeline.handle;

const messageIdOf = (event: SesEvent.SesEvent) => event.Records[0]?.ses.mail.messageId ?? "";

describe("emulated stack", () => {
  it.layer(stack, { timeout: 60_000 })((it) => {
    it.effect("serves the API over a function URL", () =>
      Effect.gen(function* () {
        expect(yield* call("/health")).toMatchObject({ status: 200, body: { status: "ok" } });
      }),
    );

    it.effect("creates an alias with a personal API token minted in the browser session", () =>
      Effect.gen(function* () {
        const { cookie } = yield* signUp("cli-user");
        const minted = yield* call("/v1/tokens", {
          cookie,
          body: { name: "laptop CLI", scopes: ["aliases:read", "aliases:write"] },
        });
        expect(minted.status).toBe(201);
        const bearer = String(minted.body.token);
        expect(bearer).toMatch(/^alias_pat_/);

        const created = yield* call("/v1/aliases", {
          bearer,
          body: { _tag: "Random", domain: "alias.test", mode: "forward" },
        });
        expect(created.status).toBe(201);
        expect((yield* call("/v1/aliases", { cookie })).body).toEqual([created.body]);
        expect((yield* call("/v1/aliases", { bearer })).body).toEqual([created.body]);

        // Out of scope, and session-only: the token can't mint itself a stronger one.
        expect((yield* call("/v1/recipients", { bearer })).status).toBe(403);
        const escalate = { name: "more", scopes: ["recipients:write"] };
        expect((yield* call("/v1/tokens", { bearer, body: escalate })).status).toBe(403);

        const revoked = yield* call(`/v1/tokens/${minted.body.id}`, { cookie, method: "DELETE" });
        expect(revoked.status).toBe(204);
        expect((yield* call("/v1/aliases", { bearer })).status).toBe(401);
      }),
    );

    it.effect(
      "signs a device in with the device authorization grant, and lets it revoke its token",
      () =>
        Effect.gen(function* () {
          const { cookie } = yield* signUp("device-user");
          const started = yield* postForm("/v1/oauth/device_authorization", {
            client_id: "alias-cli",
            scope: "aliases:read",
          });
          expect(started.status).toBe(200);
          expect(started.body.verification_uri).toBe(`${origin}/device`);
          const userCode = String(started.body.user_code);
          const poll = () =>
            postForm("/v1/oauth/token", {
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: String(started.body.device_code),
              client_id: "alias-cli",
            });

          const looked = yield* call("/v1/device/lookup", { cookie, body: { userCode } });
          expect(looked.body).toMatchObject({ clientName: "Alias CLI", scopes: ["aliases:read"] });
          expect((yield* call("/v1/device/approve", { cookie, body: { userCode } })).status).toBe(
            204,
          );

          const issued = yield* poll();
          expect(issued).toMatchObject({
            status: 200,
            body: { token_type: "Bearer", scope: "aliases:read" },
            cacheControl: "no-store",
          });
          const bearer = String(issued.body.access_token);
          expect((yield* call("/v1/me", { bearer })).body).toMatchObject({
            username: "device-user",
          });
          expect((yield* poll()).body).toMatchObject({ error: "invalid_grant" });

          expect((yield* postForm("/v1/oauth/revoke", { token: bearer })).status).toBe(200);
          expect((yield* call("/v1/me", { bearer })).status).toBe(401);
        }),
    );

    it.effect("posts a signed mail.forwarded event to the owner's webhook endpoint", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const hooked = yield* owner("hooked");
        const receiver = yield* Receiver.make();
        const registered = yield* call("/v1/webhooks", {
          cookie: hooked.cookie,
          body: { url: receiver.url, eventTypes: ["mail.forwarded"] },
        });
        expect(registered.status).toBe(201);
        const secret = String(registered.body.secret);

        const event = yield* smtp({
          from: '"Store" <orders@store.example>',
          to: hooked.alias,
          subject: "Your order",
          text: "Secret order details",
        });
        expect(yield* invoke(event)).toEqual([{ _tag: "Forwarded" }]);
        const lambda = yield* SqsEventSource.SqsEventSource;
        expect(yield* lambda.poll).toEqual({ received: 1, deleted: 1 });

        const [request] = receiver.received;
        expect(receiver.received).toHaveLength(1);
        const isAuthentic = yield* Webhook.verify({
          secret,
          id: request?.headers["webhook-id"] ?? "",
          timestamp: Number(request?.headers["webhook-timestamp"]),
          signature: request?.headers["webhook-signature"] ?? "",
          body: request?.body ?? "",
          // The stack runs on the test clock; the receiver checks against the same one.
          nowSeconds: Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000),
        });
        expect(isAuthentic).toBe(true);
        const [contact] = (yield* call(`/v1/aliases/${hooked.alias.split("@")[1]}/shop/contacts`, {
          cookie: hooked.cookie,
        })).body;
        expect(JSON.parse(request?.body ?? "null")).toEqual({
          type: "mail.forwarded",
          timestamp: expect.any(String),
          data: { aliasId: expect.any(String), address: hooked.alias, contactId: contact.id },
        });
        // Metadata only: no content, subject or sender address.
        expect(request?.body).not.toMatch(/store\.example|order/i);
      }),
    );

    it.effect("connects the official MCP client through OAuth with PKCE, both protocol eras", () =>
      Effect.gen(function* () {
        const { cookie } = yield* signUp("mcp-user");
        const { connect } = yield* authorizeMcp(cookie, ["aliases:read", "aliases:write"]);

        // A 2026-07-28 client: stateless, with server/discover.
        const modern = yield* connect("auto");
        expect(modern.getNegotiatedProtocolVersion()).toBe("2026-07-28");
        expect(modern.getServerVersion()).toMatchObject({ name: "alias" });
        const { tools } = yield* Effect.promise(() => modern.listTools());
        expect(tools.map((tool) => tool.name)).toContain("create_alias");
        const created = yield* Effect.promise(() =>
          modern.callTool({
            name: "create_alias",
            arguments: { address: "agent@mcp-user.alias.test" },
          }),
        );
        expect(created).toMatchObject({
          isError: false,
          structuredContent: { address: "agent@mcp-user.alias.test", isActive: true },
        });
        yield* Effect.promise(() => modern.close());

        // A client that opens with `initialize` (the SDK's default) gets the same tools.
        const legacy = yield* connect("legacy");
        expect(legacy.getNegotiatedProtocolVersion()).toBe("2025-11-25");
        const listed = yield* Effect.promise(() =>
          legacy.callTool({ name: "list_aliases", arguments: {} }),
        );
        expect(listed).toMatchObject({
          structuredContent: { aliases: [{ address: "agent@mcp-user.alias.test" }] },
        });
        yield* Effect.promise(() => legacy.close());

        // The web app sees the alias, and the connected app.
        expect((yield* call("/v1/aliases", { cookie })).body).toMatchObject([
          { address: "agent@mcp-user.alias.test" },
        ]);
        expect((yield* call("/v1/oauth/grants", { cookie })).body).toMatchObject([
          { clientName: "SDK stack test", scopes: ["aliases:read", "aliases:write"] },
        ]);
      }),
    );

    it.effect("sends mail an MCP client drafted only after the user sends it in the web app", () =>
      Effect.gen(function* () {
        const { url } = yield* FunctionUrlServer.FunctionUrlServer;
        const ida = yield* owner("ida");
        // Grace writes to the alias, which makes her a contact.
        const event = yield* smtp({
          from: '"Grace" <grace@store.example>',
          to: ida.alias,
          subject: "Your order",
          text: "When would you like it delivered?",
        });
        expect(yield* invoke(event)).toEqual([{ _tag: "Forwarded" }]);

        const { connect } = yield* authorizeMcp(ida.cookie, ["contacts:read", "mail:send"]);
        const approvals: Array<string> = [];
        const client = yield* connect("auto", (sdk) =>
          // The host's URL elicitation: here the user opens the page and presses Send.
          sdk.setRequestHandler("elicitation/create", async (request) => {
            const page = new URL(request.params.mode === "url" ? request.params.url : "x:");
            approvals.push(page.pathname);
            const sent = await fetch(`${url}/v1${page.pathname}/send`, {
              method: "POST",
              headers: { cookie: ida.cookie, origin },
            });
            expect(sent.status).toBe(200);
            return { action: "accept" };
          }),
        );
        const contacts = yield* Effect.promise(() =>
          client.callTool({ name: "list_contacts", arguments: { address: ida.alias } }),
        );
        const contact = Schema.decodeUnknownSync(
          Schema.Struct({
            structuredContent: Schema.Struct({
              contacts: Schema.Tuple([
                Schema.Struct({ id: Schema.String, address: Schema.String }),
              ]),
            }),
          }),
        )(contacts).structuredContent.contacts[0];
        expect(contact.address).toBe("grace@store.example");
        expect(yield* sentTo("grace@store.example")).toEqual([]);

        const result = yield* Effect.promise(() =>
          client.callTool({
            name: "send_mail",
            arguments: {
              from: ida.alias,
              contactId: contact.id,
              subject: "Delivery",
              text: "Tuesday works, thanks!",
            },
          }),
        );
        expect(result).toMatchObject({ isError: false, structuredContent: { status: "sent" } });
        expect(approvals).toEqual([expect.stringMatching(/^\/outbox\/drf_/)]);
        const [mail] = yield* sentTo("grace@store.example");
        expect(mail?.from).toBe(ida.alias);
        expect(Option.getOrNull(field(mail?.text ?? "", "subject"))).toBe("Delivery");
        expect(mail?.text).not.toContain(ida.mailbox);
        yield* Effect.promise(() => client.close());
      }),
    );

    it.effect("answers unknown aliases with the typed 404", () =>
      Effect.gen(function* () {
        const { cookie } = yield* signUp("visitor");
        const { status, body } = yield* call("/v1/aliases/alias.test/nobody", { cookie });
        expect(status).toBe(404);
        expect(body).toMatchObject({ _tag: "AliasNotFound" });
      }),
    );

    it.effect(
      "forwards mail to an alias to the owner's verified mailbox, and replies come back out as the alias",
      () =>
        Effect.gen(function* () {
          yield* Transport.ensureIdentity("alias.test");
          const ada = yield* owner("ada");

          // Inbound: a shop writes to the alias.
          const event = yield* smtp({
            from: '"Store" <orders@store.example>',
            to: "Shop@Ada.alias.test",
            subject: "Order confirmed",
            text: "Thanks for your order!",
          });
          expect(yield* invoke(event)).toEqual([{ _tag: "Forwarded" }]);

          // The first mail to the mailbox was its confirmation.
          const forwarded = (yield* sentTo(ada.mailbox)).at(-1);
          const reverse = forwarded?.from ?? "";
          expect(reverse).toMatch(/^shop\+r\.[a-z2-7]+@ada\.alias\.test$/);
          const forwardedText = forwarded?.text ?? "";
          expect(field(forwardedText, "from")).toEqual(
            Option.some(`"Store (orders@store.example)" <${reverse}>`),
          );
          expect(field(forwardedText, "reply-to")).toEqual(field(forwardedText, "from"));
          expect(field(forwardedText, "subject")).toEqual(Option.some("Order confirmed"));
          expect(forwardedText).toContain("Thanks for your order!");
          // Forward-only: nothing of the message stays behind.
          const gone = yield* Effect.flip(Inbound.readMessage(spoolBucket, messageIdOf(event)));
          expect(gone._tag).toBe("MessageGone");

          // Reply: the owner answers from their real mailbox through the reverse alias.
          // The client quotes the thread, including the owner's own earlier message.
          const replyBody = [
            "Where is my parcel?",
            "",
            "Ada Lovelace",
            "",
            `On Tue, Store (orders@store.example) <${reverse}> wrote:`,
            "> Thanks for your order!",
            ">",
            `> On Mon, Ada Lovelace <${ada.mailbox}> wrote:`,
            ">> I'd like to order the blue one.",
            ">> -- ",
            `>> Ada Lovelace, ${ada.mailbox.toUpperCase()}`,
            "",
          ].join("\r\n");
          const replyEvent = yield* smtp({
            from: `"Ada Lovelace" <${ada.mailbox}>`,
            to: reverse,
            subject: "Re: Order confirmed",
            text: replyBody,
            headers: {
              "User-Agent": "Thunderbird/128.0",
              "X-Mailer": "Thunderbird",
              "X-Originating-IP": "[198.51.100.7]",
            },
          });
          expect(yield* invoke(replyEvent)).toEqual([{ _tag: "Replied" }]);

          const [reply] = yield* sentTo("orders@store.example");
          expect(reply?.from).toBe("shop@ada.alias.test");
          const replyText = reply?.text ?? "";
          expect(field(replyText, "from")).toEqual(Option.some("shop@ada.alias.test"));
          expect(field(replyText, "to")).toEqual(Option.some("orders@store.example"));
          expect(field(replyText, "message-id")).toEqual(
            Option.some(expect.stringMatching(/^<[\w-]+@ada\.alias\.test>$/)),
          );
          expect(replyText).toContain("Where is my parcel?");

          // Header diff: what the owner's mail client sent (as SES stored it) against what the
          // contact receives. Only the alias's own From and To are new; everything identifying the
          // owner's mailbox, client or network is gone.
          const sentHeaders = yield* Effect.map(SesEvent.decode(replyEvent), (decoded) =>
            Arr.map(decoded.Records[0]?.ses.mail.headers ?? [], (header) =>
              header.name.toLowerCase(),
            ),
          );
          const received = Arr.map(fields(replyText), (found) => found.name);
          expect(Arr.difference(received, sentHeaders)).toEqual([]);
          expect(Arr.difference(sentHeaders, received).toSorted()).toEqual([
            "authentication-results",
            "received",
            "return-path",
            "user-agent",
            "x-mailer",
            "x-originating-ip",
            "x-ses-spam-verdict",
            "x-ses-virus-verdict",
          ]);
          // Body diff: only the owner's name and address in the quoted lines changed. Their own
          // signature line, which they typed, stays.
          // nodemailer sent it quoted-printable; the relay re-encodes it the same way.
          expect(field(replyText, "content-transfer-encoding")).toEqual(
            Option.some("quoted-printable"),
          );
          const body = replyText
            .slice(replyText.indexOf("\r\n\r\n") + 4)
            .replace(/=\r\n/g, "")
            .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
              String.fromCharCode(Number.parseInt(hex, 16)),
            );
          expect(body).toBe(
            replyBody
              .replace(
                `> On Mon, Ada Lovelace <${ada.mailbox}>`,
                "> On Mon, shop@ada.alias.test <shop@ada.alias.test>",
              )
              .replace(
                `>> Ada Lovelace, ${ada.mailbox.toUpperCase()}`,
                ">> shop@ada.alias.test, shop@ada.alias.test",
              ),
          );
          // The owner's real address appears nowhere: not in a header, not in the body, not in
          // the envelope.
          expect(replyText.toLowerCase()).not.toContain(ada.mailbox);
          expect(reply?.to).toEqual(["orders@store.example"]);
        }),
    );

    it.effect("drops spoofed replies: a stranger, or the owner's address without DKIM", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const bob = yield* owner("bob");
        yield* invoke(
          yield* smtp({
            from: "news@shop.example",
            to: bob.alias,
            subject: "Newsletter",
            text: "Deals!",
          }),
        );
        const reverse = (yield* sentTo(bob.mailbox)).at(-1)?.from ?? "";
        expect(reverse).toContain("+r.");

        const stranger = yield* smtp({
          from: "mallory@evil.example",
          to: reverse,
          subject: "Send as Bob",
          text: "spoofed",
        });
        expect(yield* invoke(stranger)).toEqual([
          { _tag: "Dropped", reason: "foreign-reply-sender" },
        ]);

        const forged = yield* smtp({
          from: bob.mailbox,
          to: reverse,
          subject: "Send as Bob",
          text: "forged From",
          verdicts: { dkim: "FAIL", dmarc: "FAIL" },
        });
        expect(yield* invoke(forged)).toEqual([
          { _tag: "Dropped", reason: "unauthenticated-reply" },
        ]);

        expect(yield* sentTo("news@shop.example")).toEqual([]);
      }),
    );

    it.effect("stops a loop through the owner's mailbox and keeps auto-replies from contacts", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const dora = yield* owner("dora");
        expect(
          yield* invoke(
            yield* smtp({
              from: "news@shop.example",
              to: dora.alias,
              subject: "Weekly deals",
              text: "Deals!",
              headers: { Precedence: "bulk", "List-Id": "<deals.shop.example>" },
            }),
          ),
        ).toEqual([{ _tag: "Forwarded" }]);
        const forwarded = (yield* sentTo(dora.mailbox)).at(-1);
        expect(field(forwarded?.text ?? "", "x-alias-forwarded")).toEqual(Option.some(dora.alias));

        // A redirect rule in the mailbox sends the copy back to the alias, headers and all.
        const looped = yield* smtpRaw({
          from: dora.mailbox,
          to: dora.alias,
          raw: forwarded?.text ?? "",
        });
        expect(yield* invoke(looped)).toEqual([{ _tag: "Dropped", reason: "loop" }]);

        // The mailbox's out-of-office reply to the reverse alias never reaches the shop.
        const outOfOffice = yield* smtp({
          from: dora.mailbox,
          to: forwarded?.from ?? "",
          subject: "Out of office",
          text: "I'm away until Monday.",
          headers: { "Auto-Submitted": "auto-replied" },
        });
        expect(yield* invoke(outOfOffice)).toEqual([{ _tag: "Dropped", reason: "auto-reply" }]);

        // The confirmation mail and the one forward; nothing went back to the shop.
        expect(yield* sentTo(dora.mailbox)).toHaveLength(2);
        expect(yield* sentTo("news@shop.example")).toEqual([]);
      }),
    );

    it.effect("removes tracking pixels from forwarded mail, and cleans links when asked", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const hana = yield* owner("hana");
        const newsletter = [
          "DKIM-Signature: v=1; a=rsa-sha256; d=shop.example; s=k1; h=from:subject; bh=x; b=y",
          "From: Shop <news@shop.example>",
          `To: ${hana.alias}`,
          "Subject: Fall sale",
          "Message-ID: <fall-sale@shop.example>",
          "MIME-Version: 1.0",
          'Content-Type: multipart/alternative; boundary="b1"',
          "",
          "--b1",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Sale: https://shop.example/sale?utm_source=mail&id=7",
          "--b1",
          "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: quoted-printable",
          "",
          '<p>Gr=C3=BC=C3=9Fe! <a href=3D"https://shop.example/sale?utm_source=3Dmail&amp;id=3D7">Sale</a></p>',
          '<img src=3D"https://img.shop.example/hero.jpg" width=3D"600" height=3D"300">',
          '<img src=3D"https://shop.us1.list-manage.com/track/open.php?u=3D1" width=3D"1" height=',
          '=3D"1">',
          "--b1--",
          "",
        ].join("\r\n");
        const forward = Effect.fn("forward")(function* () {
          const event = yield* smtpRaw({
            from: "news@shop.example",
            to: hana.alias,
            raw: newsletter,
          });
          expect(yield* invoke(event)).toEqual([{ _tag: "Forwarded" }]);
          return (yield* sentTo(hana.mailbox)).at(-1)?.text ?? "";
        });
        /** The HTML part as the mailbox shows it. */
        const html = (raw: string) =>
          (raw.split("Content-Transfer-Encoding: quoted-printable\r\n\r\n")[1] ?? "")
            .split("\r\n--b1--")[0]
            ?.replace(/=\r\n/g, "")
            .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
              String.fromCharCode(Number.parseInt(hex, 16)),
            );

        // Tracker blocking is on by default.
        const blocked = yield* forward();
        expect(html(blocked)).not.toContain("list-manage.com");
        expect(html(blocked)).toContain('<img src="https://img.shop.example/hero.jpg"');
        expect(html(blocked)).toContain("utm_source=mail");
        expect(field(blocked, "x-alias-trackers-removed")).toEqual(Option.some("1"));

        const changed = yield* call("/v1/settings", {
          cookie: hana.cookie,
          method: "PATCH",
          body: { imageProtection: "off", isLinkCleaningEnabled: true },
        });
        expect(changed).toMatchObject({ status: 200, body: { imageProtection: "off" } });
        const cleaned = yield* forward();
        expect(html(cleaned)).toContain("list-manage.com/track/open.php");
        expect(html(cleaned)).toContain('<a href="https://shop.example/sale?id=7">Sale</a>');
        expect(cleaned).toContain("Sale: https://shop.example/sale?id=7\r\n");
        expect(field(cleaned, "x-alias-links-cleaned")).toEqual(Option.some("2"));

        // Only the body and the counting fields differ: the sender's signature never travels
        // (SES signs the forward for the alias domain), and the MIME fields stay as they came.
        const names = (raw: string) =>
          Arr.filter(
            Arr.map(fields(raw), (found) => found.name),
            (name) => !name.startsWith("x-alias-trackers") && !name.startsWith("x-alias-links"),
          );
        expect(names(cleaned)).toEqual(names(blocked));
        expect(names(blocked)).not.toContain("dkim-signature");
        Arr.map(["mime-version", "content-type", "message-id", "subject"], (name) =>
          expect(field(blocked, name)).toEqual(field(newsletter, name)),
        );
      }),
    );

    it.effect("loads a forwarded newsletter's images through the image proxy when asked", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Transport.ensureIdentity("alias.test");
          const ines = yield* owner("ines");
          const host = yield* ImageProxyTesting.origin;
          const changed = yield* call("/v1/settings", {
            cookie: ines.cookie,
            method: "PATCH",
            body: { imageProtection: "proxy-images" },
          });
          expect(changed).toMatchObject({ status: 200, body: { imageProtection: "proxy-images" } });
          const newsletter = [
            "From: Shop <news@shop.example>",
            `To: ${ines.alias}`,
            "Subject: New arrivals",
            "MIME-Version: 1.0",
            "Content-Type: text/html; charset=utf-8",
            "",
            `<p>New in!</p><img src="${host.url}/pixel.png" width="600" height="300" alt="Hero">`,
            '<img src="https://shop.us1.list-manage.com/track/open.php?u=1" width="1" height="1">',
            "",
          ].join("\r\n");
          const event = yield* smtpRaw({
            from: "news@shop.example",
            to: ines.alias,
            raw: newsletter,
          });
          expect(yield* invoke(event)).toEqual([{ _tag: "Forwarded" }]);
          const forwarded = (yield* sentTo(ines.mailbox)).at(-1)?.text ?? "";
          expect(field(forwarded, "x-alias-images-proxied")).toEqual(Option.some("1"));
          expect(field(forwarded, "x-alias-trackers-removed")).toEqual(Option.some("1"));
          expect(forwarded).not.toContain(host.url);
          expect(forwarded).not.toContain("list-manage.com");

          // The mailbox opens the mail: the image comes from the proxy, and the sender's host
          // sees the proxy's request, with nothing of the reader's.
          const src = /<img src="([^"]+)" width="600"/.exec(forwarded)?.[1] ?? "";
          const image = yield* Effect.promise(() =>
            fetch(src, {
              headers: { cookie: "webmail=session", referer: "https://mail.example/" },
            }),
          );
          expect(image.status).toBe(200);
          expect(image.headers.get("content-type")).toBe("image/png");
          expect(new Uint8Array(yield* Effect.promise(() => image.arrayBuffer()))).toEqual(
            ImageProxyTesting.PNG,
          );
          expect(host.requests).toHaveLength(1);
          expect(host.requests[0]?.headers.cookie).toBeUndefined();
          expect(host.requests[0]?.headers.referer).toBeUndefined();
        }),
      ),
    );

    it.effect("forwards the first mail to a new address on my subdomain once I opt in", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const erin = yield* owner("erin");
        const mail = (to: string) =>
          smtp({ from: "hello@club.example", to, subject: "Welcome", text: "Glad you joined." });

        expect(yield* invoke(yield* mail("club@erin.alias.test"))).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);

        const enabled = yield* call("/v1/settings", {
          cookie: erin.cookie,
          method: "PATCH",
          body: { isOnTheFlyEnabled: true },
        });
        expect(enabled).toMatchObject({ status: 200, body: { isOnTheFlyEnabled: true } });

        expect(yield* invoke(yield* mail("Club@Erin.alias.test"))).toEqual([{ _tag: "Forwarded" }]);
        const forwarded = (yield* sentTo(erin.mailbox)).at(-1);
        expect(forwarded?.from).toMatch(/^club\+r\.[a-z2-7]+@erin\.alias\.test$/);
        expect(forwarded?.text).toContain("Glad you joined.");

        // The new alias is the user's own, like one made in the web app.
        const listed = yield* call("/v1/aliases", { cookie: erin.cookie });
        expect(listed.body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ address: "club@erin.alias.test", isActive: true }),
          ]),
        );

        // Someone else's subdomain is not mine to fill.
        expect(yield* invoke(yield* mail("club@frank.alias.test"))).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);
      }),
    );

    it.effect("drops a blocked sender's mail, and replies to a deleted contact", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const gil = yield* owner("gil");
        const write = (from: string) =>
          smtp({ from, to: gil.alias, subject: "Hello", text: `From ${from}` });
        expect(yield* invoke(yield* write("spam@pushy.example"))).toEqual([{ _tag: "Forwarded" }]);
        expect(yield* invoke(yield* write("friend@pal.example"))).toEqual([{ _tag: "Forwarded" }]);
        const friendReverse = (yield* sentTo(gil.mailbox)).at(-1)?.from ?? "";

        const contactsPath = `/v1/aliases/gil.alias.test/shop/contacts`;
        const listed = yield* call(contactsPath, { cookie: gil.cookie });
        const contacts = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ id: Schema.String, address: Schema.String })),
        )(listed.body);
        expect(contacts).toHaveLength(2);
        const idOf = (address: string) =>
          contacts.find((contact) => contact.address === address)?.id ?? "";
        const spammer = { id: idOf("spam@pushy.example") };
        const friend = { id: idOf("friend@pal.example") };

        const blocked = yield* call(`${contactsPath}/${spammer?.id}`, {
          cookie: gil.cookie,
          method: "PATCH",
          body: { isBlocked: true },
        });
        expect(blocked).toMatchObject({ status: 200, body: { isBlocked: true } });
        expect(yield* invoke(yield* write("spam@pushy.example"))).toEqual([
          { _tag: "Dropped", reason: "blocked-contact" },
        ]);

        const deleted = yield* call(`${contactsPath}/${friend?.id}`, {
          cookie: gil.cookie,
          method: "DELETE",
        });
        expect(deleted.status).toBe(204);
        const reply = yield* smtp({
          from: gil.mailbox,
          to: friendReverse,
          subject: "Re: Hello",
          text: "Still there?",
        });
        expect(yield* invoke(reply)).toEqual([{ _tag: "Dropped", reason: "unknown-contact" }]);

        expect(yield* sentTo("friend@pal.example")).toEqual([]);
        // The confirmation mail and the two first forwards.
        expect(yield* sentTo(gil.mailbox)).toHaveLength(3);
      }),
    );

    it.effect("stops forwarding to a mailbox that hard-bounces, and says so in the API", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const bounce = "bounce@simulator.amazonses.com";
        const ivy = yield* owner("ivy", bounce);

        // The confirmation mail bounced: SES published it, SNS invoked the feedback Lambda.
        const subscriber = yield* SnsSubscriber.SnsSubscriber;
        const event = yield* SnsEvent.decode(
          JSON.parse(JSON.stringify(yield* Queue.take(subscriber.events))),
        );
        expect(yield* Feedback.handle(event)).toEqual([
          { _tag: "Bounced", suppressed: 1, marked: 1 },
        ]);
        const listed = yield* call("/v1/recipients", { cookie: ivy.cookie });
        expect(listed.body).toEqual([
          expect.objectContaining({ address: bounce, bouncedAt: expect.any(String) }),
        ]);
        const suppressed = yield* SESV2.getSuppressedDestination({ EmailAddress: bounce });
        expect(suppressed.SuppressedDestination?.Reason).toBe("BOUNCE");

        // Mail to the alias is no longer sent to the bouncing mailbox.
        const forward = yield* smtp({
          from: "orders@store.example",
          to: ivy.alias,
          subject: "Invoice",
          text: "Attached.",
        });
        expect(yield* invoke(forward)).toEqual([{ _tag: "Dropped", reason: "recipient-bounced" }]);
        expect(yield* sentTo(bounce)).toHaveLength(1);
      }),
    );

    it.effect("encrypts forwarded mail to the mailbox's OpenPGP key, set over the API", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const pia = yield* owner("pia");
        // Dated at the epoch, so the key is valid whatever time the stack's clock shows.
        const { publicKey, privateKey } = yield* Effect.promise(() =>
          openpgp.generateKey({
            userIDs: [{ email: pia.mailbox }],
            type: "curve25519",
            date: DateTime.toDate(DateTime.makeUnsafe(0)),
            format: "object",
          }),
        );
        const [destination] = (yield* call("/v1/recipients", { cookie: pia.cookie })).body;
        const stored = yield* call(`/v1/recipients/${destination.id}/encryption`, {
          cookie: pia.cookie,
          method: "PUT",
          body: { publicKey: publicKey.armor(), isSubjectHidden: true },
        });
        expect(stored.status).toBe(200);
        expect(stored.body.encryption.fingerprint).toBe(publicKey.getFingerprint().toUpperCase());

        const event = yield* smtp({
          from: '"Store" <orders@store.example>',
          to: pia.alias,
          subject: "Your invoice 2026-118",
          text: "Total: 42 EUR. Thanks for shopping!",
        });
        expect(yield* invoke(event)).toEqual([{ _tag: "Forwarded" }]);
        const forwarded = (yield* sentTo(pia.mailbox)).at(-1);
        const raw = forwarded?.text ?? "";
        // What SES sent is PGP/MIME; routing is outside, the content and the subject are not.
        expect(field(raw, "content-type")).toEqual(
          Option.some(
            'multipart/encrypted; protocol="application/pgp-encrypted"; boundary="=_alias_pgp_mime"',
          ),
        );
        expect(field(raw, "subject")).toEqual(Option.some("[...]"));
        expect(field(raw, "x-alias-forwarded")).toEqual(Option.some(pia.alias));
        expect(Option.getOrElse(field(raw, "from"), () => "")).toContain(forwarded?.from ?? "-");
        expect(raw).not.toContain("42 EUR");
        expect(raw).not.toContain("invoice");

        const armored = /-----BEGIN PGP MESSAGE-----[\s\S]*-----END PGP MESSAGE-----/.exec(raw);
        const { data } = yield* Effect.promise(() =>
          openpgp
            .readMessage({ armoredMessage: armored?.[0] ?? "" })
            .then((message) =>
              openpgp.decrypt({ message, decryptionKeys: privateKey, format: "binary" }),
            ),
        );
        const inner = new TextDecoder().decode(data);
        expect(field(inner, "subject")).toEqual(Option.some("Your invoice 2026-118"));
        expect(inner).toContain("Total: 42 EUR. Thanks for shopping!");

        // The owner's reply from the mailbox goes to the store as written, unencrypted.
        const reply = yield* smtp({
          from: pia.mailbox,
          to: forwarded?.from ?? "",
          subject: "Re: Your invoice",
          text: "Thanks!",
        });
        expect(yield* invoke(reply)).toEqual([{ _tag: "Replied" }]);
        const answer = (yield* sentTo("orders@store.example")).at(-1);
        expect(answer?.text).toContain("Thanks!");
        expect(field(answer?.text ?? "", "content-type")).not.toEqual(
          Option.some(expect.stringContaining("multipart/encrypted")),
        );

        // Removing the key forwards in the clear again.
        yield* call(`/v1/recipients/${destination.id}/encryption`, {
          cookie: pia.cookie,
          method: "DELETE",
        });
        yield* invoke(
          yield* smtp({
            from: "orders@store.example",
            to: pia.alias,
            subject: "Hi",
            text: "Plain",
          }),
        );
        expect((yield* sentTo(pia.mailbox)).at(-1)?.text).toContain("Plain");
      }),
    );

    it.effect("sends nothing extra when Lambda redelivers an event", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const cleo = yield* owner("cleo");
        const event = yield* smtp({
          from: "orders@store.example",
          to: cleo.alias,
          subject: "Invoice",
          text: "Attached.",
        });
        expect(yield* invoke(event)).toEqual([{ _tag: "Forwarded" }]);
        expect(yield* invoke(event)).toEqual([{ _tag: "Duplicate" }]);
        // The confirmation mail and one forward.
        expect(yield* sentTo(cleo.mailbox)).toHaveLength(2);
      }),
    );

    it.effect("deleting an alias drops its mail and its reverse aliases, and its contacts", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const lin = yield* owner("lin");
        const write = () =>
          smtp({ from: "lin-store@store.example", to: lin.alias, subject: "Hi", text: "Hello" });
        expect(yield* invoke(yield* write())).toEqual([{ _tag: "Forwarded" }]);
        const reverse = (yield* sentTo(lin.mailbox)).at(-1)?.from ?? "";
        const contactsPath = "/v1/aliases/lin.alias.test/shop/contacts";
        expect(yield* call(contactsPath, { cookie: lin.cookie })).toMatchObject({
          body: [{ address: "lin-store@store.example" }],
        });

        const aliasPath = "/v1/aliases/lin.alias.test/shop";
        expect((yield* call(aliasPath, { cookie: lin.cookie, method: "DELETE" })).status).toBe(204);
        // Nothing in the table remembers the contact, a third party's address.
        expect(yield* itemsMentioning("lin-store@store.example")).toEqual([]);
        expect(yield* invoke(yield* write())).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);
        const reply = yield* smtp({
          from: lin.mailbox,
          to: reverse,
          subject: "Re: Hi",
          text: "Still there?",
        });
        expect(yield* invoke(reply)).toEqual([{ _tag: "Dropped", reason: "unknown-alias" }]);
        expect(yield* sentTo("lin-store@store.example")).toEqual([]);

        // Its owner may create it again: a new alias that knows no one yet.
        const again = yield* call("/v1/aliases", {
          cookie: lin.cookie,
          body: { _tag: "Address", address: lin.alias, mode: "forward" },
        });
        expect(again.status).toBe(201);
        expect(yield* call(contactsPath, { cookie: lin.cookie })).toMatchObject({ body: [] });
        // The old reverse alias stays dead: it named a contact the new alias doesn't have.
        expect(yield* invoke(reply)).toEqual([{ _tag: "Dropped", reason: "unknown-contact" }]);
      }),
    );

    it.effect("erasing an account leaves only tombstones, and its username stays taken", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const moe = yield* owner("moe");
        const write = () =>
          smtp({ from: "moe-pal@pal.example", to: moe.alias, subject: "Hi", text: "Hello" });
        expect(yield* invoke(yield* write())).toEqual([{ _tag: "Forwarded" }]);
        const reverse = (yield* sentTo(moe.mailbox)).at(-1)?.from ?? "";

        const started = yield* call("/v1/me/erase/options", { cookie: moe.cookie, body: {} });
        const erased = yield* call("/v1/me/erase", {
          cookie: moe.cookie,
          body: {
            challengeId: started.body.challengeId,
            credential: moe.authenticator.get(started.body.options),
          },
        });
        expect(erased.status).toBe(204);

        expect((yield* call("/v1/me", { cookie: moe.cookie })).status).toBe(401);
        expect(
          yield* call("/v1/auth/register/options", { body: { username: "moe" } }),
        ).toMatchObject({ status: 409, body: { _tag: "UsernameTaken" } });
        expect(yield* invoke(yield* write())).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);
        const reply = yield* smtp({
          from: moe.mailbox,
          to: reverse,
          subject: "Re: Hi",
          text: "Still there?",
        });
        expect(yield* invoke(reply)).toEqual([{ _tag: "Dropped", reason: "unknown-alias" }]);

        // Nothing names the user, their mailbox or their contact any more.
        expect(yield* itemsMentioning(moe.userId)).toEqual([]);
        expect(yield* itemsMentioning("moe@mailbox.example")).toEqual([]);
        expect(yield* itemsMentioning("moe-pal@pal.example")).toEqual([]);
        // What is left: the username's tombstone, and the idempotency claim of the one message
        // forwarded, which names the alias address until its one-week TTL (PLAN.md §20.15).
        const left = yield* itemsMentioning("moe.alias.test");
        expect(Arr.map(left, (item) => item.pk?.S?.split("#")[0])).toEqual(["DELIVERY"]);
        expect(yield* itemsMentioning(`USERNAME#${Username.skeleton("moe")}`)).toEqual([
          {
            pk: { S: `USERNAME#${Username.skeleton("moe")}` },
            sk: { S: "USERNAME" },
            deletedAt: expect.anything(),
          },
        ]);
      }),
    );

    it.effect(
      "a custom domain: added, records published, verified, mail forwarded and replied to as the domain",
      () =>
        Effect.gen(function* () {
          const { cookie, mailbox } = yield* owner("cora");
          const added = yield* call("/v1/domains", { cookie, body: { domain: "Cora.Example" } });
          expect(added).toMatchObject({
            status: 201,
            body: { domain: "cora.example", status: "pending" },
          });
          const records = Schema.decodeUnknownSync(
            Schema.Array(
              Schema.Struct({
                type: Schema.Literals(["TXT", "MX", "CNAME"]),
                name: Schema.String,
                value: Schema.String,
                priority: Schema.optionalKey(Schema.Number),
              }),
            ),
          )(added.body.records);

          // SES receives for the new identity at once; the pipeline drops it until verified.
          const early = yield* smtp({
            from: "orders@store.example",
            to: "shop@cora.example",
            subject: "Too early",
            text: "Nobody verified this yet.",
          });
          expect(yield* invoke(early)).toEqual([{ _tag: "Dropped", reason: "unverified-domain" }]);

          // The owner publishes every record the wizard lists, then asks for a check.
          const dns = yield* DohServer.DohServer;
          yield* dns.setZone(
            "cora.example",
            Arr.map(records, (record) => ({
              name: record.name,
              type: record.type,
              data:
                record.type === "MX" ? `${record.priority ?? 10} ${record.value}` : record.value,
            })),
          );
          const checked = yield* call("/v1/domains/cora.example/check", { cookie, body: {} });
          expect(checked).toMatchObject({ status: 200, body: { status: "verified" } });
          const states = Schema.decodeUnknownSync(
            Schema.Struct({ records: Schema.Array(Schema.Struct({ state: Schema.String })) }),
          )(checked.body);
          expect(Arr.dedupe(Arr.map(states.records, (record) => record.state))).toEqual(["ok"]);

          const created = yield* call("/v1/aliases", {
            cookie,
            body: { _tag: "Address", address: "shop@cora.example", mode: "forward" },
          });
          expect(created.status).toBe(201);

          const event = yield* smtp({
            from: '"Store" <orders@store.example>',
            to: "shop@cora.example",
            subject: "Your order",
            text: "Shipped.",
          });
          expect(yield* invoke(event)).toEqual([{ _tag: "Forwarded" }]);
          const forwarded = Arr.last(yield* sentTo(mailbox));
          const reverse = Option.getOrElse(
            Option.map(forwarded, (email) => email.from),
            () => "",
          );
          expect(reverse).toMatch(/^shop\+r\.[a-z2-7]+@cora\.example$/);
          expect(Option.flatMap(forwarded, (email) => field(email.text, "subject"))).toEqual(
            Option.some("Your order"),
          );

          const reply = yield* smtp({
            from: mailbox,
            to: reverse,
            subject: "Re: Your order",
            text: "Thanks!",
          });
          expect(yield* invoke(reply)).toEqual([{ _tag: "Replied" }]);
          const replied = Arr.last(yield* sentTo("orders@store.example"));
          expect(Option.map(replied, (email) => email.from)).toEqual(
            Option.some("shop@cora.example"),
          );
          expect(Option.flatMap(replied, (email) => field(email.text, "from"))).toEqual(
            Option.some("shop@cora.example"),
          );
          expect(Option.map(replied, (email) => email.text.includes(mailbox))).toEqual(
            Option.some(false),
          );
        }),
    );
  });
});
