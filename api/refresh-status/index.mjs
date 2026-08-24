// GET /api/refresh-status — the run a preceding POST /api/refresh triggered, and how it is going
// (M9 follow-up, decision 61).

import { run } from '../lib/adapter.mjs';
import { handleRefreshStatus } from '../lib/handlers.mjs';

export default async function refreshStatus(context, req) {
  await run(handleRefreshStatus, context, req);
}
