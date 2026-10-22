import type { Scope } from "@alias/contracts";

/** What each scope lets a token or connected app do, for the device and consent pages. */
export const SCOPE_LABELS: Record<Scope, string> = {
  "aliases:read": "See your aliases and their counters",
  "aliases:write": "Create, deactivate and delete aliases",
  "contacts:read": "See who wrote to your aliases (their addresses and names)",
  "contacts:write": "Block, unblock and remove contacts",
  "domains:read": "See your custom domains and their DNS status",
  "domains:write": "Add, check and remove custom domains",
  "recipients:read": "See your forwarding addresses",
  "recipients:write": "Add and remove forwarding addresses",
  "settings:read": "See your account settings",
  "settings:write": "Change your account settings",
  "mail:send":
    "Draft emails from your aliases to their contacts; each waits for you to send it in Alias",
};
