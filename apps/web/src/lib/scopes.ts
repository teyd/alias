import type { Scope } from "@alias/contracts";

/** What each scope lets a token or connected app do, for the device and consent pages. */
export const SCOPE_LABELS: Record<Scope, string> = {
  "aliases:read": "See your aliases and their counters",
  "aliases:write": "Create, deactivate and delete aliases",
  "contacts:read": "See who wrote to your aliases (their addresses and names)",
  "contacts:write": "Block, unblock and remove contacts",
  "domains:read": "See your custom domains and their DNS status",
  "domains:write": "Add, check and remove custom domains",
  "inboxes:read": "Read mail kept in your inboxes and temporary inboxes, codes included",
  "inboxes:write": "Create temporary inboxes and delete kept mail",
  "recipients:read": "See your forwarding addresses",
  "recipients:write": "Add and remove forwarding addresses",
  "rules:read": "See your blocklist and rules (they may name senders' addresses)",
  "rules:write": "Block senders everywhere, and create, change and delete rules",
  "settings:read": "See your account settings",
  "settings:write": "Change your account settings",
  "usernames:read": "See your usernames and their settings",
  "usernames:write": "Change and delete your additional usernames, with their aliases",
  "mail:send":
    "Draft emails from your aliases to their contacts; each waits for you to send it in Alias",
};
