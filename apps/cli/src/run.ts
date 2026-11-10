import { randomUUID } from 'node:crypto';
import { NodeServices } from '@effect/platform-node';
import { Effect, Redacted } from 'effect';
import { resolveAgentSession } from './agent-session.ts';
import {
  ApprovalStopped,
  approvalFailure,
  processSignal,
  requestValues,
} from './approval-wait.ts';
import {
  CliFailure,
  networkError,
  type RequestFailure,
  tryCli,
} from './errors.ts';
import type { Host } from './host.ts';
import { planOutput } from './output-plan.ts';
import { currentDirectory, projectSecrets } from './project-secrets.ts';
import { startRelay } from './relay-client.ts';
import { parseRun } from './run-arguments.ts';
import { CommandFailure, resolveCommand, runCommand } from './run-command.ts';
import { session } from './session.ts';

function runFailure(error: RequestFailure) {
  const approval = approvalFailure(error);
  if (approval instanceof ApprovalStopped) return approval;
  if (error.server.tag === 'SecretsForbidden')
    return new CliFailure(
      error.server.paths
        .map((path) => `Access to ${path} is forbidden.`)
        .join(' '),
    );
  if (
    [
      'SecretNotFound',
      'SecretKeyUnavailable',
      'VaultNotConfigured',
      // A resumed run that differs from the one that asked is refused by name.
      'InvalidRun',
    ].includes(error.server.tag) &&
    error.publicMessage
  )
    return new CliFailure(error.publicMessage);
  return error;
}
export function run(
  host: Host,
  args: string[],
  write: (message: string) => void,
  status: (message: string) => void = write,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const workingDirectory = yield* currentDirectory;
      const project = yield* projectSecrets(workingDirectory);
      const parsed = yield* tryCli(() =>
        parseRun(args, workingDirectory, project),
      );
      const file = yield* resolveCommand(parsed.command[0]);
      const agentSession = resolveAgentSession((name) => process.env[name]);
      const plan = yield* planOutput(parsed.masking);
      const relay =
        plan.kind === 'masked' ? yield* startRelay(plan) : undefined;
      const { url, request } = yield* session(host);
      const attemptId = parsed.approval ?? randomUUID();
      const ask = request((api, headers) =>
        api.machine.values({
          headers,
          payload: {
            ...parsed.input,
            approval: { attemptId },
            ...(agentSession ? { agentSession } : {}),
          },
        }),
      );
      const delivered = yield* Effect.scoped(
        Effect.gen(function* () {
          const signal = yield* processSignal;
          return yield* requestValues({
            ask,
            withdraw: (id) =>
              request((api, headers) =>
                api.machine.withdraw({ headers, params: { id } }),
              ),
            attempt: { id: attemptId, resumed: parsed.approval !== undefined },
            status,
            signal,
          });
        }),
      ).pipe(
        Effect.mapError((error) =>
          error instanceof ApprovalStopped ? error : runFailure(error),
        ),
      );
      const values = new Map(
        delivered.values.map(({ path, value }) => [path, value]),
      );
      if (relay) yield* relay.send(delivered.values);
      const env: NodeJS.ProcessEnv = Object.assign(
        Object.create(null),
        process.env,
      );
      for (const { name, path } of parsed.mappings) {
        const value = values.get(path);
        if (!value) return yield* Effect.fail(networkError(url));
        env[name] = Redacted.value(value);
      }
      return yield* runCommand(
        file,
        parsed.command,
        env,
        plan.kind === 'masked'
          ? ['inherit', ...plan.child]
          : ['inherit', 'inherit', 'inherit'],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.catch((error) => {
        (error instanceof ApprovalStopped ? status : write)(error.message);
        return Effect.succeed(
          error instanceof CommandFailure || error instanceof ApprovalStopped
            ? error.code
            : 1,
        );
      }),
    ),
  );
}
