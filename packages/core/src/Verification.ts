import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as R from "effect/Record";
import * as Str from "effect/String";
import * as Html from "./internal/html.ts";

/**
 * Finds the one-time code and the verification ("magic") link in a message (PLAN.md §3.6, step
 * 1): deterministic, no I/O, and never visits a link. It reads the subject, the text body and
 * the HTML body as text, scores every candidate by the words around it, and answers only when
 * one candidate clearly wins. Precision comes first: a wrong code typed into a form is worse
 * than none, so ties and weak evidence give none. `test/verification-corpus` measures it.
 */

export interface Input {
  readonly subject: Option.Option<string>;
  readonly text: Option.Option<string>;
  readonly html: Option.Option<string>;
}

export interface Found {
  /** The code as the user types it: group separators removed (`482 913` → `482913`). */
  readonly code: Option.Option<string>;
  /** The link's `href`, entities decoded. Never visited. */
  readonly link: Option.Option<string>;
}

/** Words that announce a one-time code, in the languages senders use most. */
const CODE_WORDS = new RegExp(
  [
    "verification",
    "verify",
    "verifizierung",
    "one[- ]?time",
    "\\botp\\b",
    "pass ?code",
    "security code",
    "login code",
    "log-?in code",
    "sign[- ]?in code",
    "confirmation code",
    "authenticat",
    "\\b2fa\\b",
    "two[- ]factor",
    "\\bmfa\\b",
    "access code",
    "\\bpin\\b",
    "\\bcode\\b",
    "bestätigung",
    "sicherheitscode",
    "anmeldecode",
    "einmal",
    "code de vérification",
    "code de confirmation",
    "code de sécurité",
    "votre code",
    "código",
    "codigo",
    "codice",
    "verificatie",
    "\\bkod\\b",
    "kod weryfikacyjny",
    "verifiering",
    "engångskod",
    "コード",
    "確認",
    "認証",
  ].join("|"),
  "iu",
);

/**
 * The subset of {@link CODE_WORDS} that only ever names a one-time code. A bare "code", "PIN" or
 * "passcode" also names meeting passcodes, booking codes and customer numbers.
 */
const STRONG_CODE_WORDS = new RegExp(
  [
    "verif",
    "one[- ]?time",
    "\\botp\\b",
    "security code",
    "log-?in code",
    "sign[- ]?in code",
    "authenticat",
    "\\b2fa\\b",
    "two[- ]factor",
    "\\bmfa\\b",
    "access code",
    "bestätigungscode",
    "sicherheitscode",
    "anmeldecode",
    "einmal",
    "code de sécurité",
    "código de seguridad",
    "codice di sicurezza",
    "kod weryfikacyjny",
    "engångskod",
    "確認コード",
    "認証コード",
    "ワンタイム",
  ].join("|"),
  "iu",
);

/**
 * Subjects of mail whose numbers are something else: meetings, bookings, orders, invoices,
 * receipts, promotions. There, only a strongly named code counts.
 */
const OTHER_MAIL_WORDS = new RegExp(
  [
    "meeting",
    "webinar",
    "invitation",
    "einladung",
    "booking",
    "reservation",
    "reservierung",
    "réservation",
    "reserva",
    "flight",
    "\\bflug",
    "order",
    "bestellung",
    "commande",
    "pedido",
    "ordine",
    "invoice",
    "rechnung",
    "facture",
    "factura",
    "fattura",
    "receipt",
    "quittung",
    "reçu",
    "recibo",
    "payment",
    "zahlung",
    "\\bsale\\b",
    "% off",
    "discount",
    "promo",
    "statement",
    "kontoauszug",
  ].join("|"),
  "iu",
);

/**
 * Words that make a nearby number something else: an order, a price, an address, a phone, a
 * booking, a promotion or a meeting.
 */
const OTHER_NUMBER_WORDS = new RegExp(
  [
    "postal",
    "post ?code",
    "\\bzip\\b",
    "\\bplz\\b",
    "postleitzahl",
    "code postal",
    "discount",
    "promo",
    "coupon",
    "voucher",
    "gutschein",
    "rabatt",
    "gift",
    "checkout",
    "order",
    "bestell",
    "commande",
    "pedido",
    "ordine",
    "invoice",
    "rechnung",
    "facture",
    "factura",
    "tracking",
    "sendung",
    "shipment",
    "parcel",
    "reference",
    "\\bref\\b",
    "booking",
    "buchung",
    "\\bpnr\\b",
    "flight",
    "\\bflug",
    "meeting",
    "webinar",
    "dial",
    "conference",
    "transaction",
    "account (?:number|no)",
    "\\biban\\b",
    "\\bcard\\b",
    "karte",
    "ending in",
    "customer (?:number|no|id)",
    "kundennummer",
    "member",
    "ticket",
    "\\bcase\\b",
    "request id",
    "phone",
    "\\btel\\b",
    "telefon",
    "\\bfax\\b",
    "\\bcall\\b",
    "hotline",
    "\\bsuite\\b",
    "street",
    "straße",
    "strasse",
    "\\bave\\b",
    "seat",
    "\\bgate\\b",
    "room",
    "\\bid\\b",
    "nummer",
    "number",
    "client",
    "cliente",
    "kunden",
    "reservation",
    "sort code",
    "numéro",
    "número",
  ].join("|"),
  "iu",
);

/** Mail about signing in or proving an address, for links. */
const AUTH_WORDS = new RegExp(
  [
    "verif",
    "confirm",
    "activat",
    "sign[- ]?in",
    "log[- ]?in",
    "magic link",
    "reset",
    "password",
    "one[- ]?time",
    "subscription",
    "opt[- ]?in",
    "bestätig",
    "aktivier",
    "anmeld",
    "zurücksetz",
    "passwort",
    "confirmer",
    "vérifi",
    "connexion",
    "connecter",
    "réinitialis",
    "confirmar",
    "verificar",
    "iniciar sesión",
    "restablecer",
    "conferma",
    "verifica",
    "accedi",
    "accesso",
    "bevestig",
    "inloggen",
    "potwierdź",
    "zaloguj",
    "bekräfta",
    "logga in",
    "確認",
    "ログイン",
    "認証",
  ].join("|"),
  "iu",
);

/** What a verification button says. */
const LINK_TEXT_WORDS = new RegExp(
  [
    "verif",
    "confirm",
    "activat",
    "sign[- ]?in",
    "log[- ]?in",
    "magic",
    "reset",
    "set (?:a )?new password",
    "choose (?:a )?new password",
    "complete (?:your )?(?:sign|registration)",
    "subscribe me",
    "yes, ",
    "bestätig",
    "aktivier",
    "anmelden",
    "einloggen",
    "zurücksetz",
    "reimposta",
    "redefinir",
    "återställ",
    "nouveau mot de passe",
    "confirmer",
    "vérifi",
    "connecter",
    "connexion",
    "réinitialis",
    "confirmar",
    "verificar",
    "iniciar sesión",
    "restablecer",
    "conferma",
    "verifica",
    "accedi",
    "bevestig",
    "verifieer",
    "inloggen",
    "potwierd",
    "zaloguj",
    "bekräfta",
    "verifiera",
    "logga in",
    "確認",
    "ログイン",
    "認証",
  ].join("|"),
  "iu",
);

/** What a verification URL's path or query says. */
const LINK_URL_WORDS =
  /verif|confirm|activat|magic|sign-?in|log-?in|\/auth\b|\/auth\/|token=|reset|password|passwort|reimposta|restablecer|redefinir|callback|validate|opt-?in|double-?opt|\/otp\b/i;

/** Links that are never the one to click: account hygiene, legal, tracking, social. */
const LINK_REFUSED_WORDS = new RegExp(
  [
    "unsubscribe",
    "abbestellen",
    "abmelden vom",
    "désinscri",
    "darse de baja",
    "privacy",
    "datenschutz",
    "terms",
    "\\bhelp\\b",
    "support",
    "preferences",
    "einstellungen",
    "settings",
    "view (?:it )?(?:in|on) (?:your )?browser",
    "im browser",
    "track",
    "sendung",
    "review (?:this |the |recent )?activity",
    "secure your account",
    "wasn.t you",
    "not you",
    "report",
    "contact us",
    "impressum",
  ].join("|"),
  "iu",
);

const MAX_CODE_DIGITS = 8;

/** URLs and addresses hold digits that are never codes; they are blanked before scanning. */
// The lookbehind starts an address only where its run of address characters starts, so a long
// run without an `@` is scanned once (PLAN.md §20.25).
const URL_OR_ADDRESS = /\b(?:https?:\/\/|www\.)\S+|(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;

interface Candidate {
  readonly code: string;
  readonly score: number;
  /** Where it was found, earlier first: subject, then each body. */
  readonly position: number;
}

/** Characters that make a number part of something bigger: a price, date, time, version, IP. */
const BEFORE = "(?<![\\p{L}\\p{N}_.,:/+#$€£¥%&=@-])";
const AFTER = "(?![\\p{L}\\p{N}_%€$£¥]|[.,:/-]\\p{N}|-[\\p{L}\\p{N}])";

const PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly isAlphanumeric: boolean }> = [
  // Google's `G-482913`: the prefix is printed, the form wants the digits.
  { pattern: /(?<![\p{L}\p{N}])G-(\d{6})(?![\p{L}\p{N}])/gu, isAlphanumeric: false },
  // One digit per table cell or spaced out: `4 8 2 9 1 3`.
  {
    pattern: new RegExp(`${BEFORE}(\\p{N}(?:[ \\u00a0]\\p{N}){3,7})${AFTER}`, "gu"),
    isAlphanumeric: false,
  },
  // Grouped: `482 913`, `482-913`, `4829 1370`.
  {
    pattern: new RegExp(`${BEFORE}(\\d{3,4}[ \\u00a0-]\\d{3,4})${AFTER}`, "gu"),
    isAlphanumeric: false,
  },
  {
    pattern: new RegExp(`${BEFORE}(\\d{4,${MAX_CODE_DIGITS}})${AFTER}`, "gu"),
    isAlphanumeric: false,
  },
  // Upper-case letters and digits, both present: `K7Q2M9`, `Q8W-3ZK`.
  {
    pattern: new RegExp(
      `${BEFORE}((?=[A-Z0-9-]*\\d)(?=[A-Z0-9-]*[A-Z])(?:[A-Z0-9]{3,4}-[A-Z0-9]{3,4}|[A-Z0-9]{5,8}))${AFTER}`,
      "gu",
    ),
    isAlphanumeric: true,
  },
];

const normalizeCode = (raw: string) => raw.replace(/[\s\u00a0-]/g, "");

const isYear = (code: string) => /^(?:19|20)\d\d$/.test(code);

/**
 * How far around a match its context is read. Real lines are far shorter; bounding it keeps a
 * mail of one huge line with many numbers linear (PLAN.md §20.25).
 */
const CONTEXT = 200;

/** Where the line holding `at` starts, looking back at most `CONTEXT`; else that far back. */
const lineStartBefore = (segment: string, at: number) => {
  const from = Math.max(0, at - CONTEXT - 1);
  const found = segment.slice(from, at).lastIndexOf("\n");
  return found === -1 ? from : from + found + 1;
};

/** Where the line holding `at` ends, looking ahead at most `CONTEXT`; else that far ahead. */
const lineEndAfter = (segment: string, at: number) => {
  const to = Math.min(segment.length, at + CONTEXT + 1);
  const found = segment.slice(at, to).indexOf("\n");
  return found === -1 ? to : at + found;
};

/** The line the match sits on, split around it, and its neighbours, each within `CONTEXT`. */
const surroundings = (segment: string, start: number, end: number) => {
  const lineStart = lineStartBefore(segment, start);
  const lineEnd = lineEndAfter(segment, end);
  const hasAbove = segment[lineStart - 1] === "\n";
  const hasBelow = segment[lineEnd] === "\n";
  const isWholeLine = (lineStart === 0 || hasAbove) && (lineEnd === segment.length || hasBelow);
  return {
    before: segment.slice(Math.max(lineStart, start - 80), start),
    after: segment.slice(end, Math.min(lineEnd, end + 60)),
    /** The line above, for codes on a line of their own under a sentence that announces them. */
    above: hasAbove ? segment.slice(lineStartBefore(segment, lineStart - 1), lineStart - 1) : "",
    /** The line below, for a code on the first line explained by the next. */
    below: hasBelow ? segment.slice(lineEnd + 1, lineEndAfter(segment, lineEnd + 1)) : "",
    isAlone:
      isWholeLine && segment.slice(lineStart, lineEnd).trim() === segment.slice(start, end).trim(),
  };
};

/** The nearest words before a match: what it is called. */
const lastWords = (text: string, count: number) =>
  Arr.takeRight(Arr.filter(text.split(/[\s:\uff1a]+/), Str.isNonEmpty), count).join(" ");

const scoreMatch = (
  segment: string,
  start: number,
  end: number,
  code: string,
  isAlphanumeric: boolean,
  isSubject: boolean,
  isOtherMail: boolean,
): number => {
  const near = surroundings(segment, start, end);
  const label = lastWords(near.before, 4);
  const following = near.after.slice(0, 40);
  const isLabelled = CODE_WORDS.test(label);
  const isAnnounced = isLabelled || CODE_WORDS.test(following);
  // A code on a line of its own, under or above the sentence that names it.
  const neighbour = near.isAlone
    ? [near.above, near.below].find((line) => CODE_WORDS.test(line))
    : undefined;
  const isAnnouncedAround = neighbour !== undefined;
  // An order, price, phone or booking number nearby names this number as something else.
  const isOtherNumber =
    OTHER_NUMBER_WORDS.test(lastWords(near.before, 3)) ||
    OTHER_NUMBER_WORDS.test(near.after.slice(0, 12)) ||
    (!isAnnounced && isAnnouncedAround && OTHER_NUMBER_WORDS.test(lastWords(neighbour ?? "", 4)));
  if (isOtherNumber) return 0;
  if (!isAnnounced && !isAnnouncedAround) return 0;
  const isStrong =
    STRONG_CODE_WORDS.test(label) ||
    STRONG_CODE_WORDS.test(following) ||
    STRONG_CODE_WORDS.test(neighbour ?? "");
  if (isOtherMail && !isStrong) return 0;
  // Letters and digits are codes only when named so right before them, or strongly.
  if (isAlphanumeric && !isStrong && !(isLabelled && !isOtherMail)) return 0;
  if (isYear(code) && !isLabelled) return 0;
  return (
    3 +
    (isLabelled ? 2 : 0) +
    (isStrong ? 1 : 0) +
    (near.isAlone ? 1 : 0) +
    (code.length === 6 ? 1 : 0) +
    (isSubject ? 1 : 0) -
    (isAlphanumeric ? 1 : 0)
  );
};

const candidatesIn = (
  segment: string,
  position: number,
  isSubject: boolean,
  isOtherMail: boolean,
) => {
  const blanked = segment.replace(URL_OR_ADDRESS, (url) => " ".repeat(url.length));
  return Arr.flatMap(PATTERNS, ({ pattern, isAlphanumeric }) =>
    Arr.map(Arr.fromIterable(blanked.matchAll(pattern)), (match): Candidate => {
      const raw = match[1] ?? "";
      const start = (match.index ?? 0) + match[0].indexOf(raw);
      const code = normalizeCode(raw);
      return {
        code,
        score: scoreMatch(
          blanked,
          start,
          start + raw.length,
          code,
          isAlphanumeric,
          isSubject,
          isOtherMail,
        ),
        position,
      };
    }),
  );
};

interface Ranked {
  readonly score: number;
  readonly position: number;
}

const byScoreThenPosition: Order.Order<Ranked> = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (candidate: Ranked) => candidate.score),
  Order.mapInput(Order.Number, (candidate: Ranked) => candidate.position),
);

/**
 * The best-ranked value, with its best occurrence, or none when another value ranks as high:
 * equal evidence for two answers is a coin toss.
 */
const winner = <A extends Ranked>(
  candidates: ReadonlyArray<A>,
  valueOf: (candidate: A) => string,
): Option.Option<{ readonly best: A; readonly isTied: boolean }> => {
  // Grouped once, not filtered once per value: mail may hold thousands of candidates.
  const perValue = Arr.getSomes(
    Arr.map(R.values(Arr.groupBy(candidates, valueOf)), (group) =>
      Arr.head(Arr.sort(group, byScoreThenPosition)),
    ),
  );
  const [first, second] = Arr.sort(perValue, byScoreThenPosition);
  return first === undefined
    ? Option.none()
    : Option.some({ best: first, isTied: second !== undefined && second.score === first.score });
};

/** The best-scored code, unless another code scored as well. */
const chooseCode = (candidates: ReadonlyArray<Candidate>): Option.Option<string> =>
  winner(
    Arr.filter(candidates, (candidate) => candidate.score > 0),
    (candidate) => candidate.code,
  ).pipe(
    Option.filter(({ isTied }) => !isTied),
    Option.map(({ best }) => best.code),
  );

interface LinkCandidate {
  readonly href: string;
  readonly score: number;
  readonly position: number;
}

const scoreLink = (href: string, text: string): number => {
  if (!/^https?:\/\//i.test(href)) return 0;
  if (LINK_REFUSED_WORDS.test(text) || LINK_REFUSED_WORDS.test(href)) return 0;
  const saysVerify = LINK_TEXT_WORDS.test(text);
  const urlSaysVerify = LINK_URL_WORDS.test(href.replace(/^https?:\/\/[^/]+/i, ""));
  return (saysVerify ? 3 : 0) + (urlSaysVerify ? 2 : 0);
};

/** How many lines above a URL are looked at for its label. */
const LABEL_LINES = 20;

/**
 * Bare URLs in a text body, with their line as what they say. The label is read within
 * `CONTEXT` of the URL and `LABEL_LINES` above it, so many URLs stay linear (PLAN.md §20.25).
 */
const textLinks = (text: string): ReadonlyArray<Html.Anchor> => {
  const lines = text.split(/\r?\n/);
  return Arr.flatMap(lines, (line, index) =>
    Arr.map(Arr.fromIterable(line.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)), (match): Html.Anchor => {
      const rest = `${line.slice(Math.max(0, match.index - CONTEXT), match.index)} ${line.slice(
        match.index + match[0].length,
        match.index + match[0].length + CONTEXT,
      )}`;
      return {
        href: match[0].replace(/(?<![.,;:!?])[.,;:!?]+$/, ""),
        // A URL on a line of its own is labelled by the text just above it.
        text: /[\p{L}]{2}/u.test(rest)
          ? rest
          : Arr.takeRight(
              Arr.filter(lines.slice(Math.max(0, index - LABEL_LINES), index), (above) =>
                Str.isNonEmpty(above.trim()),
              ),
              2,
            ).join(" "),
      };
    }),
  );
};

/**
 * The best link, unless another one scored as well. A tie between two links that both say and
 * look like verification (5) keeps the first: such mails repeat the button as a fallback URL.
 */
const chooseLink = (anchors: ReadonlyArray<Html.Anchor>): Option.Option<string> =>
  winner(
    Arr.filter(
      Arr.map(anchors, (anchor, position): LinkCandidate => ({
        href: anchor.href,
        score: scoreLink(anchor.href, anchor.text),
        position,
      })),
      (candidate) => candidate.score >= 3,
    ),
    (candidate) => candidate.href,
  ).pipe(
    Option.filter(({ best, isTied }) => !isTied || best.score >= 5),
    Option.map(({ best }) => best.href),
  );

export const extract = (input: Input): Found => {
  const htmlText = Option.map(input.html, Html.toText);
  const bodies = Arr.getSomes([Option.map(input.text, Html.tidy), htmlText]);
  const subject = Option.getOrElse(input.subject, () => "");
  const isOtherMail = OTHER_MAIL_WORDS.test(subject);
  const candidates = [
    ...candidatesIn(subject, 0, true, isOtherMail),
    ...Arr.flatMap(bodies, (body, index) => candidatesIn(body, index + 1, false, isOtherMail)),
  ];
  const isAboutAuth = AUTH_WORDS.test(subject) || Arr.some(bodies, (body) => AUTH_WORDS.test(body));
  const links = [
    ...Option.match(input.html, { onNone: () => [], onSome: Html.anchors }),
    ...Option.match(input.text, { onNone: () => [], onSome: textLinks }),
  ];
  return {
    code: chooseCode(candidates),
    link: isAboutAuth ? chooseLink(links) : Option.none(),
  };
};
