import { AskFirstMark, ApprovalRemember as Remember } from '@nook/contract';
import { Schema } from 'effect';

const rowFacts = {
  id: Schema.String,
  machine_id: Schema.String,
  machine_name: Schema.String,
  attempt_id: Schema.String,
  agent: Schema.NullOr(Schema.String),
  agent_session: Schema.NullOr(Schema.String),
  agent_thread: Schema.NullOr(Schema.String),
  secrets_json: Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        coveredBy: Schema.NullOr(AskFirstMark),
      }),
    ),
  ),
  covered_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  purpose: Schema.String,
  working_directory: Schema.String,
  executable: Schema.String,
  client: Schema.NullOr(Schema.String),
  requested_at: Schema.Number,
  expires_at: Schema.Number,
};
export const StoredRequest = Schema.Union([
  Schema.Struct({
    ...rowFacts,
    status: Schema.Literal('pending'),
    remember: Schema.Null,
    decided_at: Schema.Null,
    valid_until: Schema.Null,
  }),
  Schema.Struct({
    ...rowFacts,
    status: Schema.Literal('approved'),
    remember: Remember,
    decided_at: Schema.Number,
    valid_until: Schema.Number,
  }),
  Schema.Struct({
    ...rowFacts,
    status: Schema.Literal('denied'),
    remember: Schema.Null,
    decided_at: Schema.Number,
    valid_until: Schema.Null,
  }),
  Schema.Struct({
    ...rowFacts,
    status: Schema.Literals(['withdrawn', 'settled']),
    remember: Schema.Null,
    decided_at: Schema.Null,
    valid_until: Schema.Null,
  }),
]);
export type StoredRequest = typeof StoredRequest.Type;
export const StoredApproved = Schema.Struct({
  id: Schema.String,
  machine_id: Schema.String,
  status: Schema.Literal('approved'),
  remember: Remember,
  decided_at: Schema.Number,
  valid_until: Schema.Number,
  covered_json: rowFacts.covered_json,
});
export type StoredApproved = typeof StoredApproved.Type;
