import { Api, MachineApi } from '@nook/contract';
import { SchemaAST } from 'effect';
import {
  HttpApi,
  type HttpApiEndpoint,
  type HttpApiGroup,
} from 'effect/http-api';

export type Route = { readonly method: string; readonly path: string };

// fileLimits.nameBytes allows 255 UTF-8 bytes: percent encoding needs at most
// 3 × 255 = 765 characters for a file-name route parameter.
export const fileRouterMaxParamLength = 800;

function endpoints<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
) {
  const found: HttpApiEndpoint.Top[] = [];
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => found.push(endpoint),
  });
  return found;
}
const route = ({ method, path }: Route): Route => ({
  method,
  path,
});
// The contract requires an Authorization header exactly where a Nook token
// authenticates the machine.
function requiresToken(endpoint: HttpApiEndpoint.Top) {
  const ast = endpoint.headers?.ast;
  return (
    ast !== undefined &&
    SchemaAST.isObjects(ast) &&
    ast.propertySignatures.some(({ name }) => name === 'authorization')
  );
}

export const ownerRoutes = endpoints(Api).map(route);
export const tokenRoutes = endpoints(MachineApi)
  .filter(requiresToken)
  .map(route);
export const revealRoute = route(Api.groups.vault.endpoints.reveal);
export const fileRoutes = [
  route(Api.groups.memories.endpoints.downloadFile),
  route(MachineApi.groups.machine.endpoints.attachFile),
  route(MachineApi.groups.machine.endpoints.downloadFile),
];

// Compares the raw pathname segment by segment, so a parameter is one
// non-empty encoded segment. HEAD reaches GET routes, as in the router.
export function matches(
  routes: readonly Route[],
  method: string,
  path: string,
) {
  const actual = path.split('/');
  return routes.some((candidate) => {
    const expected = candidate.path.split('/');
    return (
      (candidate.method === method ||
        (candidate.method === 'GET' && method === 'HEAD')) &&
      expected.length === actual.length &&
      expected.every((segment, index) =>
        segment.startsWith(':')
          ? actual[index] !== ''
          : segment === actual[index],
      )
    );
  });
}
