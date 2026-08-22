// POST /api/acceptance — record an acceptance result in the record its manifest names
// (decisions 14, 35, 37).

import { run } from '../lib/adapter.mjs';
import { handleAcceptance } from '../lib/handlers.mjs';

export default async function acceptance(context, req) {
  await run(handleAcceptance, context, req);
}
