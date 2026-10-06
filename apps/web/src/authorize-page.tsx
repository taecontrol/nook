import type { AuthorizationPhase } from './authorizations-api';
import { useAuthorizationFlow } from './authorizations-api';
import { AuthorizationLayout, CodeStep, ResultStep } from './authorize-parts';
import { RequestStep } from './authorize-request';

function requestPhase(
  phase: AuthorizationPhase,
): phase is 'request' | 'approving' | 'denying' {
  return ['request', 'approving', 'denying'].includes(phase);
}
function resultPhase(
  phase: AuthorizationPhase,
): phase is 'approved' | 'denied' | 'expired' | 'used' {
  return ['approved', 'denied', 'expired', 'used'].includes(phase);
}

export function AuthorizePage() {
  const flow = useAuthorizationFlow();
  if (['code', 'checking'].includes(flow.phase))
    return (
      <AuthorizationLayout step={1}>
        <CodeStep
          code={flow.code}
          change={flow.setCode}
          submit={flow.lookup}
          checking={flow.phase === 'checking'}
          failure={flow.failure}
        />
      </AuthorizationLayout>
    );
  if (requestPhase(flow.phase) && flow.request)
    return (
      <AuthorizationLayout step={2}>
        <RequestStep
          code={flow.code}
          request={flow.request}
          name={flow.name}
          access={flow.access}
          onName={flow.setName}
          phase={flow.phase}
          failed={flow.failure === 'network'}
          decide={flow.decide}
          changeCode={flow.changeCode}
        />
      </AuthorizationLayout>
    );
  if (!resultPhase(flow.phase)) return null;
  return (
    <AuthorizationLayout>
      <ResultStep
        kind={flow.phase}
        code={flow.code}
        name={flow.name}
        grant={flow.access.grant}
      />
    </AuthorizationLayout>
  );
}
