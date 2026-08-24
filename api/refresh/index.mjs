// POST /api/refresh — trigger the project's own rebuild workflow, committing nothing (M9,
// decision 61).

import { run } from '../lib/adapter.mjs';
import { handleRefresh } from '../lib/handlers.mjs';

export default async function refresh(context, req) {
  await run(handleRefresh, context, req);
}
