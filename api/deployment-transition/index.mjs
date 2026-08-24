// POST /api/deployment-transition — record a deployment stage transition in the log a
// workstream's manifest names (decisions 35, 37; M8).

import { run } from '../lib/adapter.mjs';
import { handleDeploymentTransition } from '../lib/handlers.mjs';

export default async function deploymentTransition(context, req) {
  await run(handleDeploymentTransition, context, req);
}
