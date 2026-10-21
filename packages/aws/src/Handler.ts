/**
 * The subset of the Node.js Lambda runtime's `context` object we rely on.
 * https://docs.aws.amazon.com/lambda/latest/dg/nodejs-context.html
 */
export interface LambdaContext {
  readonly awsRequestId: string;
  readonly functionName: string;
  readonly getRemainingTimeInMillis: () => number;
}

/** An async Node.js Lambda handler, as the runtime calls it. */
export type LambdaHandler<Event, Result> = (
  event: Event,
  context: LambdaContext,
) => Promise<Result>;
