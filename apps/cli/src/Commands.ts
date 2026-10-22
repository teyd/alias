import {
  AliasClient,
  type AliasView,
  Api,
  type Contact,
  DeviceLogin,
  type Scope,
} from "@alias/sdk";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Str from "effect/String";
import { HttpApiClient } from "effect/http-api";
import { Argument, Command, Flag } from "effect/cli";
import { Credentials } from "./Credentials.ts";
import { InvalidAddress, NoSuchContact, NotConfirmed, forUser } from "./Errors.ts";
import * as Output from "./Output.ts";
import * as Session from "./Session.ts";

/** What `alias login` asks for: everything the commands below need, nothing more. */
export const CLI_SCOPES = [
  "aliases:read",
  "aliases:write",
  "contacts:read",
  "contacts:write",
  "recipients:read",
] as const satisfies Arr.NonEmptyReadonlyArray<Scope>;

/** An alias address as the API addresses it: `{ domain, local }`, lowercased. */
const parseAddress = (input: string) => {
  const address = Str.toLowerCase(Str.trim(input));
  const at = address.lastIndexOf("@");
  const local = address.slice(0, Math.max(at, 0));
  const domain = address.slice(at + 1);
  return at > 0 && Str.isNonEmpty(domain)
    ? Effect.succeed({ domain, local })
    : Effect.fail(new InvalidAddress({ input }));
};

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of a table"),
  Flag.withDefault(false),
);

const aliasArgument = Argument.String("alias").pipe(
  Argument.withDescription("The alias address, e.g. shop@ada.alias.example"),
);

const aliasRow = (alias: AliasView): Output.Row => ({
  address: alias.address,
  active: alias.isActive,
  mode: alias.mode,
  forwarded: alias.forwardedCount,
  blocked: alias.blockedCount,
  id: alias.id,
});
const ALIAS_COLUMNS = ["address", "active", "mode", "forwarded", "blocked"];

const contactRow = (contact: Contact): Output.Row => ({
  id: contact.id,
  address: contact.address,
  name: contact.name,
  blocked: contact.isBlocked,
  since: DateTime.formatIso(contact.createdAt),
});

// --- login, logout, whoami ---------------------------------------------------------------------

const login = Command.make(
  "login",
  {
    apiUrl: Flag.String("api-url").pipe(
      Flag.withDescription(
        `The Alias web app's URL (default: ALIAS_API_URL or ${Session.DEFAULT_API_URL})`,
      ),
      Flag.optional,
    ),
  },
  Effect.fn("alias.login")(function* ({ apiUrl }) {
    const baseUrl = yield* Session.apiUrlFor(apiUrl);
    const credentials = yield* Credentials;
    const previous = yield* credentials.load;
    const issued = yield* DeviceLogin.login({
      baseUrl,
      clientId: "alias-cli",
      scopes: CLI_SCOPES,
      onCode: (started) =>
        Console.log(
          Arr.join(
            [
              "To log in, open this page and approve the request:",
              "",
              `  ${started.verificationUriComplete}`,
              "",
              `Check that it shows the code ${started.userCode}. It expires in ${Duration.format(started.expiresIn)}.`,
              "Waiting for approval…",
            ],
            "\n",
          ),
        ),
    });
    const client = yield* AliasClient.make({ baseUrl, token: issued.token });
    const me = yield* client.account.me();
    yield* credentials.save({
      apiUrl: baseUrl,
      username: me.username,
      token: Redacted.value(issued.token),
    });
    // The login this one replaces needn't stay valid. Best effort: it may be gone already.
    yield* Option.match(previous, {
      onNone: () => Effect.void,
      onSome: (old) => revokeQuietly(old.apiUrl, old.token),
    });
    yield* Console.log(`Logged in to ${baseUrl} as ${me.username}.`);
  }, forUser),
).pipe(Command.withDescription("Log in through the web app (device code), and keep the token"));

/** Revokes a token (RFC 7009); a failure only means it can't be revoked from here. */
const revokeQuietly = (baseUrl: string, token: string) =>
  HttpApiClient.make(Api, { baseUrl }).pipe(
    Effect.flatMap((client) => client.oauth.revoke({ payload: { token } })),
    Effect.ignore,
  );

const logout = Command.make(
  "logout",
  {},
  Effect.fn("alias.logout")(function* () {
    const credentials = yield* Credentials;
    const stored = yield* credentials.load;
    yield* Option.match(stored, {
      onNone: () => Effect.void,
      onSome: (found) => revokeQuietly(found.apiUrl, found.token),
    });
    const isForgotten = yield* credentials.clear;
    yield* Console.log(isForgotten ? "Logged out; the token is revoked." : "Not logged in.");
    if (yield* Session.isFromEnvironment) {
      yield* Console.log("ALIAS_TOKEN is still set in this environment.");
    }
  }, forUser),
).pipe(Command.withDescription("Revoke the saved token and forget it"));

const whoami = Command.make(
  "whoami",
  { json },
  Effect.fn("alias.whoami")(function* ({ json: isJson }) {
    const client = yield* Session.client();
    const me = yield* client.account.me();
    yield* Output.record(isJson, { username: me.username, userId: me.userId });
  }, forUser),
).pipe(Command.withDescription("Show who the saved token belongs to"));

// --- aliases -----------------------------------------------------------------------------------

const listAliases = Command.make(
  "list",
  { json },
  Effect.fn("alias.aliases.list")(function* ({ json: isJson }) {
    const client = yield* Session.client();
    const aliases = yield* client.aliases.list();
    yield* Output.rows(isJson, ALIAS_COLUMNS, Arr.map(aliases, aliasRow), "No aliases yet.");
  }, forUser),
).pipe(Command.withDescription("List your aliases"), Command.withAlias("ls"));

const createAlias = Command.make(
  "create",
  {
    address: Flag.String("address").pipe(
      Flag.withDescription("Claim this address on your own subdomain (shop@you.alias.example)"),
      Flag.optional,
    ),
    domain: Flag.String("domain").pipe(
      Flag.withDescription("Shared domain for a random address (default: the first one)"),
      Flag.optional,
    ),
    json,
  },
  Effect.fn("alias.aliases.create")(function* ({ address, domain, json: isJson }) {
    const client = yield* Session.client();
    const created = yield* Option.match(address, {
      onSome: (claimed) =>
        client.aliases.create({ payload: { _tag: "Address", address: claimed, mode: "forward" } }),
      onNone: () =>
        Option.match(domain, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.map(client.aliases.domains(), (domains) =>
              Option.getOrElse(Arr.head(domains.shared), () => ""),
            ),
        }).pipe(
          Effect.flatMap((chosen) =>
            client.aliases.create({ payload: { _tag: "Random", domain: chosen, mode: "forward" } }),
          ),
        ),
    });
    yield* isJson ? Output.record(true, aliasRow(created)) : Console.log(created.address);
  }, forUser),
).pipe(
  Command.withDescription("Create an alias: random on a shared domain, or --address on yours"),
);

const setActive = (name: "enable" | "disable", isActive: boolean) =>
  Command.make(
    name,
    { alias: aliasArgument },
    Effect.fn(`alias.aliases.${name}`)(function* ({ alias }) {
      const client = yield* Session.client();
      const params = yield* parseAddress(alias);
      const updated = yield* client.aliases.update({ params, payload: { isActive } });
      yield* Console.log(
        `${updated.address} ${isActive ? "forwards mail again" : "is disabled: its mail is dropped"}.`,
      );
    }, forUser),
  ).pipe(
    Command.withDescription(
      isActive
        ? "Forward an alias's mail again"
        : "Stop forwarding an alias's mail (keeps the alias)",
    ),
  );

const deleteAlias = Command.make(
  "delete",
  {
    alias: aliasArgument,
    isConfirmed: Flag.Boolean("yes").pipe(
      Flag.withDescription("Confirm: the alias and its contacts are gone for good"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("alias.aliases.delete")(function* ({ alias, isConfirmed }) {
    if (!isConfirmed) return yield* new NotConfirmed();
    const client = yield* Session.client();
    const params = yield* parseAddress(alias);
    yield* client.aliases.remove({ params });
    yield* Console.log(`Deleted ${params.local}@${params.domain}.`);
  }, forUser),
).pipe(Command.withDescription("Delete an alias for good (needs --yes)"));

const aliases = Command.make("aliases").pipe(
  Command.withDescription("Your aliases"),
  Command.withSubcommands([
    listAliases,
    createAlias,
    setActive("enable", true),
    setActive("disable", false),
    deleteAlias,
  ]),
);

// --- contacts ----------------------------------------------------------------------------------

const listContacts = Command.make(
  "list",
  { alias: aliasArgument, json },
  Effect.fn("alias.contacts.list")(function* ({ alias, json: isJson }) {
    const client = yield* Session.client();
    const params = yield* parseAddress(alias);
    const contacts = yield* client.contacts.list({ params });
    yield* Output.rows(
      isJson,
      ["id", "address", "name", "blocked", "since"],
      Arr.map(contacts, contactRow),
      "Nobody wrote to this alias yet.",
    );
  }, forUser),
).pipe(Command.withDescription("List who wrote to an alias"), Command.withAlias("ls"));

const setBlocked = (name: "block" | "unblock", isBlocked: boolean) =>
  Command.make(
    name,
    {
      alias: aliasArgument,
      contact: Argument.String("contact").pipe(
        Argument.withDescription("The contact's id or address"),
      ),
    },
    Effect.fn(`alias.contacts.${name}`)(function* ({ alias, contact }) {
      const client = yield* Session.client();
      const params = yield* parseAddress(alias);
      const contacts = yield* client.contacts.list({ params });
      const wanted = Str.toLowerCase(Str.trim(contact));
      const found = Arr.findFirst(
        contacts,
        (candidate) => candidate.id === contact || Str.toLowerCase(candidate.address) === wanted,
      );
      if (Option.isNone(found)) return yield* new NoSuchContact();
      const updated = yield* client.contacts.update({
        params: { ...params, contactId: found.value.id },
        payload: { isBlocked },
      });
      yield* Console.log(
        isBlocked
          ? `Blocked ${updated.address}: its mail to ${alias} is dropped.`
          : `Unblocked ${updated.address}.`,
      );
    }, forUser),
  ).pipe(
    Command.withDescription(
      isBlocked ? "Drop a contact's mail to an alias" : "Let a blocked contact through again",
    ),
  );

const contacts = Command.make("contacts").pipe(
  Command.withDescription("Who wrote to your aliases"),
  Command.withSubcommands([listContacts, setBlocked("block", true), setBlocked("unblock", false)]),
);

// --- recipients --------------------------------------------------------------------------------

const listRecipients = Command.make(
  "list",
  { json },
  Effect.fn("alias.recipients.list")(function* ({ json: isJson }) {
    const client = yield* Session.client();
    const recipients = yield* client.recipients.list();
    yield* Output.rows(
      isJson,
      ["address", "verified", "default", "bounced"],
      Arr.map(recipients, (recipient) => ({
        address: recipient.address,
        verified: recipient.isVerified,
        default: recipient.isDefault,
        bounced: Option.map(recipient.bouncedAt, DateTime.formatIso),
        id: recipient.id,
      })),
      "No forwarding addresses yet: add one in the web app.",
    );
  }, forUser),
).pipe(Command.withDescription("List your forwarding addresses"), Command.withAlias("ls"));

const recipients = Command.make("recipients").pipe(
  Command.withDescription("Your forwarding addresses"),
  Command.withSubcommands([listRecipients]),
);

/** `alias`: the whole command line. */
export const alias = Command.make("alias").pipe(
  Command.withDescription("Email aliases from the terminal"),
  Command.withSubcommands([login, logout, whoami, aliases, contacts, recipients]),
);
