import * as Arr from "effect/Array";

/**
 * SES classic receipt-rule recipient matching, as documented in
 * https://docs.aws.amazon.com/ses/latest/dg/receiving-email-receipt-rules-console-walkthrough.html
 *
 * - `user@example.com` matches that address and its `+label` variants
 *   (unless the condition itself carries a label).
 * - `example.com` matches the domain but not its subdomains.
 * - `.example.com` matches every subdomain but not the parent domain.
 * - An empty recipient list matches every verified domain.
 */
export interface ReceiptRule {
  readonly name: string;
  readonly enabled: boolean;
  readonly recipients: ReadonlyArray<string>;
  /** S3 action: stores the raw message at `objectKeyPrefix + messageId`. */
  readonly s3: { readonly bucket: string; readonly objectKeyPrefix: string };
  /** Lambda action after the S3 action. Its event carries headers and verdicts, not the body. */
  readonly lambda?: {
    readonly functionArn: string;
    readonly invocationType: "Event" | "RequestResponse";
  };
  readonly scanEnabled: boolean;
}

const stripLabel = (local: string): string => {
  const plus = local.indexOf("+");
  return plus === -1 ? local : local.slice(0, plus);
};

const isWithinVerified = (domain: string, verifiedDomains: ReadonlyArray<string>): boolean =>
  verifiedDomains.some((verified) => domain === verified || domain.endsWith(`.${verified}`));

export const conditionMatches = (condition: string, recipient: string): boolean => {
  const normalizedCondition = condition.toLowerCase();
  const normalizedRecipient = recipient.toLowerCase();
  const at = normalizedRecipient.lastIndexOf("@");
  const local = normalizedRecipient.slice(0, at);
  const domain = normalizedRecipient.slice(at + 1);

  if (normalizedCondition.includes("@")) {
    if (normalizedCondition === normalizedRecipient) return true;
    const [conditionLocal = ""] = normalizedCondition.split("@");
    return (
      !conditionLocal.includes("+") && `${stripLabel(local)}@${domain}` === normalizedCondition
    );
  }
  if (normalizedCondition.startsWith(".")) {
    return domain.endsWith(normalizedCondition);
  }
  return domain === normalizedCondition;
};

export const ruleMatches = (
  rule: ReceiptRule,
  recipient: string,
  verifiedDomains: ReadonlyArray<string>,
): boolean => {
  if (!rule.enabled) return false;
  const domain = recipient.slice(recipient.lastIndexOf("@") + 1).toLowerCase();
  if (!isWithinVerified(domain, verifiedDomains)) return false;
  return (
    Arr.isReadonlyArrayEmpty(rule.recipients) ||
    rule.recipients.some((condition) => conditionMatches(condition, recipient))
  );
};
