/**
 * Monthly cost model for the candidate designs, mail included.
 * Prices verified 2026-10-21 against aws.amazon.com/ses/pricing, the AWS Price List API (eu-west-1)
 * and developers.cloudflare.com (Email Service, Workers, D1, R2 pricing pages).
 * Run: `node scripts/cost-model.ts`. Edit SCENARIOS or ASSUME to try other numbers.
 */

interface Scenario {
  readonly name: string;
  readonly users: number;
  /** Mails delivered to existing aliases (forwarded or stored) per month. */
  readonly mails: number;
  /** Dashboard, CLI, MCP and temp-mail API requests per month. */
  readonly apiRequests: number;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  { name: "pre-launch (you + testers)", users: 5, mails: 2_000, apiRequests: 20_000 },
  { name: "early beta", users: 100, mails: 30_000, apiRequests: 300_000 },
  { name: "growing", users: 1_000, mails: 300_000, apiRequests: 3_000_000 },
  { name: "100k users (20 mails/user)", users: 100_000, mails: 2_000_000, apiRequests: 10_000_000 },
];

const ASSUME = {
  /** Catch-all spam / unknown recipients, as a share of real mail. SES bills it; CF Email Routing doesn't. */
  junkShare: 0.3,
  /** Average inbound size. SES bills chunks by volume: size ÷ 256 KB × $0.09/1k (AWS pricing example 3). */
  avgInboundKb: 50,
  /** Attachment GB per 1,000 outbound mails (≈30 KB average). */
  attachmentGbPer1k: 0.03,
  lambdaGbSecondsPerMail: 0.25 * 0.4,
  lambdaGbSecondsPerApi: 0.25 * 0.1,
  rruPerReceived: 1,
  wruPerMail: 1.5,
  rruPerApi: 2,
  wruPerApi: 0.1,
  gbPerUser: 0.0002,
  workerCpuMsPerMail: 20,
  workerCpuMsPerApi: 5,
  d1RowsWrittenPerMail: 2,
} as const;

const PRICE = {
  ses: { inboundPer1k: 0.1, chunkPer1k: 0.09, outboundPer1k: 0.1, attachmentPerGb: 0.12 },
  s3: { putPer1k: 0.005, getPer1k: 0.0004 },
  lambda: {
    freeRequests: 1e6,
    perMRequests: 0.2,
    freeGbSeconds: 400_000,
    perGbSecond: 0.0000133334,
  },
  dynamodb: { perMRru: 0.1415, perMWru: 0.705, freeGb: 25, perGbMonth: 0.283 },
  cloudfront: { freeRequests: 10e6, perMRequests: 1.2 },
  workers: {
    base: 5,
    includedRequests: 10e6,
    perMRequests: 0.3,
    includedCpuMs: 30e6,
    perMCpuMs: 0.02,
  },
  d1: { includedWrites: 50e6, perMWrites: 1, includedGb: 5, perGbMonth: 0.75 },
  cfEmailSending: { includedPerMonth: 3_000, perThousand: 0.35 },
  sns: { freeHttp: 100_000, perMHttp: 0.6 },
  awsEgress: { freeGb: 100, perGb: 0.09 },
} as const;

const over = (used: number, free: number) => Math.max(0, used - free);
const received = (s: Scenario) => s.mails * (1 + ASSUME.junkShare);

const sesOutbound = (s: Scenario) =>
  (s.mails / 1000) *
  (PRICE.ses.outboundPer1k + ASSUME.attachmentGbPer1k * PRICE.ses.attachmentPerGb);

const workersPlatform = (s: Scenario) => {
  const requests = received(s) + s.apiRequests;
  const cpuMs = received(s) * ASSUME.workerCpuMsPerMail + s.apiRequests * ASSUME.workerCpuMsPerApi;
  const writes = s.mails * ASSUME.d1RowsWrittenPerMail;
  return (
    PRICE.workers.base +
    (over(requests, PRICE.workers.includedRequests) / 1e6) * PRICE.workers.perMRequests +
    (over(cpuMs, PRICE.workers.includedCpuMs) / 1e6) * PRICE.workers.perMCpuMs +
    (over(writes, PRICE.d1.includedWrites) / 1e6) * PRICE.d1.perMWrites +
    over(s.users * ASSUME.gbPerUser, PRICE.d1.includedGb) * PRICE.d1.perGbMonth
  );
};

/** A: everything on Cloudflare. Inbound via Email Routing (free); outbound via Email Sending. */
const cloudflareOnly = (s: Scenario) =>
  workersPlatform(s) +
  (over(s.mails, PRICE.cfEmailSending.includedPerMonth) / 1000) * PRICE.cfEmailSending.perThousand;

/** B: Cloudflare for inbound + compute + storage; SES only for outbound. */
const cloudflarePlusSesOut = (s: Scenario) => workersPlatform(s) + sesOutbound(s);

/** D: SES for all mail (in + out), compute + DB + storage on Cloudflare (SES → S3 + SNS → Worker). */
const sesAllCloudflareCompute = (s: Scenario) => {
  const rx = received(s);
  const sesIn =
    (rx / 1000) * PRICE.ses.inboundPer1k +
    ((rx * ASSUME.avgInboundKb) / 256 / 1000) * PRICE.ses.chunkPer1k;
  const spool = (rx / 1000) * (PRICE.s3.putPer1k + PRICE.s3.getPer1k);
  const sns = (over(rx, PRICE.sns.freeHttp) / 1e6) * PRICE.sns.perMHttp;
  const egressGb = (rx * ASSUME.avgInboundKb) / 1024 / 1024;
  const egress = over(egressGb, PRICE.awsEgress.freeGb) * PRICE.awsEgress.perGb;
  return workersPlatform(s) + sesIn + spool + sns + egress + sesOutbound(s);
};

/** C: all AWS. SES in/out, S3 spool, Lambda, DynamoDB, CloudFront. */
const awsOnly = (s: Scenario) => {
  const rx = received(s);
  const sesIn =
    (rx / 1000) * PRICE.ses.inboundPer1k +
    ((rx * ASSUME.avgInboundKb) / 256 / 1000) * PRICE.ses.chunkPer1k;
  const spool = (rx / 1000) * (PRICE.s3.putPer1k + PRICE.s3.getPer1k);
  const requests = rx + s.apiRequests;
  const gbSeconds =
    rx * ASSUME.lambdaGbSecondsPerMail + s.apiRequests * ASSUME.lambdaGbSecondsPerApi;
  const lambda =
    (over(requests, PRICE.lambda.freeRequests) / 1e6) * PRICE.lambda.perMRequests +
    over(gbSeconds, PRICE.lambda.freeGbSeconds) * PRICE.lambda.perGbSecond;
  const dynamodb =
    ((rx * ASSUME.rruPerReceived + s.apiRequests * ASSUME.rruPerApi) / 1e6) *
      PRICE.dynamodb.perMRru +
    ((s.mails * ASSUME.wruPerMail + s.apiRequests * ASSUME.wruPerApi) / 1e6) *
      PRICE.dynamodb.perMWru +
    over(s.users * ASSUME.gbPerUser, PRICE.dynamodb.freeGb) * PRICE.dynamodb.perGbMonth;
  const edge =
    (over(s.apiRequests, PRICE.cloudfront.freeRequests) / 1e6) * PRICE.cloudfront.perMRequests;
  return sesIn + spool + sesOutbound(s) + lambda + dynamodb + edge;
};

const usd = (value: number) => `$${value.toFixed(2)}`.padStart(14);

console.log(
  [
    "scenario".padEnd(28),
    "A: CF only".padStart(14),
    "B: CF + SES out".padStart(14),
    "C: AWS only".padStart(14),
    "D: SES all+CF".padStart(14),
  ].join(" "),
);
for (const s of SCENARIOS) {
  console.log(
    [
      s.name.padEnd(28),
      usd(cloudflareOnly(s)),
      usd(cloudflarePlusSesOut(s)),
      usd(awsOnly(s)),
      usd(sesAllCloudflareCompute(s)),
    ].join(" "),
  );
}
console.log(
  "\nTotals include mail. Cloudflare Email Routing inbound is free; SES bills every received mail, junk included.",
);
