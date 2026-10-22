import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";

/**
 * What a challenge was issued for. Registration remembers who is signing up; Erasure, whose
 * account the signed-in user confirmed they want erased.
 */
const Ceremony = Schema.TaggedUnion({
  Registration: { userId: Schema.String, username: Schema.String },
  Authentication: {},
  Erasure: { userId: Schema.String },
});
export type Ceremony = typeof Ceremony.Type;
export const Registration = (fields: { readonly userId: string; readonly username: string }) =>
  Ceremony.cases.Registration.make(fields);
export const Authentication = () => Ceremony.cases.Authentication.make({});
export const Erasure = (userId: string) => Ceremony.cases.Erasure.make({ userId });
export const {
  Registration: isRegistration,
  Authentication: isAuthentication,
  Erasure: isErasure,
} = Ceremony.guards;

/** A WebAuthn challenge the server issued and has not seen answered yet. */
export interface Challenge {
  readonly id: string;
  /** base64url, exactly as sent in the options. */
  readonly challenge: string;
  readonly ceremony: Ceremony;
  readonly expiresAt: DateTime.Utc;
}

export class ChallengeRepo extends Context.Service<
  ChallengeRepo,
  {
    readonly create: (challenge: Challenge) => Effect.Effect<void, DatabaseError>;
    /**
     * Deletes the challenge and returns it, so each challenge is answered at most once. None for
     * unknown, already used and expired challenges (TTL deletes late).
     */
    readonly take: (id: string) => Effect.Effect<Option.Option<Challenge>, DatabaseError>;
  }
>()("@alias/db/ChallengeRepo") {}

const challengeKey = (id: string) => ({ pk: { S: `CHALLENGE#${id}` }, sk: { S: "CHALLENGE" } });

const ChallengeItem = Item.codec(
  Schema.Struct({
    id: Attribute.S,
    challenge: Attribute.S,
    ceremony: Attribute.S.pipe(Schema.decodeTo(Schema.fromJsonString(Ceremony))),
    expiresAt: Attribute.EpochSeconds,
  }),
  "Challenge",
);

const make = Effect.fn("ChallengeRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();

  return ChallengeRepo.of({
    create: (challenge) =>
      ChallengeItem.encode(challenge).pipe(
        Effect.flatMap((item) =>
          DynamoDB.putItem({
            TableName: table.name,
            Item: { ...challengeKey(challenge.id), ...item },
            ConditionExpression: "attribute_not_exists(pk)",
          }).pipe(Effect.mapError(databaseError("PutItem"))),
        ),
        Effect.asVoid,
        Effect.provide(client),
      ),

    take: Effect.fn("ChallengeRepo.take")(function* (id) {
      const result = yield* DynamoDB.deleteItem({
        TableName: table.name,
        Key: challengeKey(id),
        ReturnValues: "ALL_OLD",
      }).pipe(Effect.mapError(databaseError("DeleteItem")), Effect.provide(client));
      const challenge = yield* ChallengeItem.decodeOption(
        Option.fromUndefinedOr(result.Attributes),
      );
      const now = yield* DateTime.now;
      return Option.filter(challenge, (found) => DateTime.isGreaterThan(found.expiresAt, now));
    }),
  });
});

export const layer = Layer.effect(ChallengeRepo, make());
