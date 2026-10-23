import * as Option from "effect/Option";

/** Hosts that may be spoken to over plain HTTP: this machine, for development and tests. */
const LOOPBACK = ["localhost", "127.0.0.1"];

/**
 * The origin of the Alias server the user typed (`alias.example` → `https://alias.example`).
 * Only `https:`, except for this machine: the sign-in and every token travel to it.
 */
export const parse = (input: string): Option.Option<string> => {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!URL.canParse(withScheme)) return Option.none();
  const url = new URL(withScheme);
  const isLoopback = LOOPBACK.includes(url.hostname);
  const isAllowed =
    (url.protocol === "https:" || (url.protocol === "http:" && isLoopback)) &&
    url.username === "" &&
    url.password === "" &&
    (isLoopback || url.hostname.includes("."));
  return isAllowed ? Option.some(url.origin) : Option.none();
};

/** The match pattern of an origin's host permission (any port: patterns can't name one). */
export const permissionPattern = (origin: string) =>
  `${new URL(origin).protocol}//${new URL(origin).hostname}/*`;
