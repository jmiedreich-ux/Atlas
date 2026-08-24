// POST /api/approve — move a proposed design to approved and scaffold its first milestone, in one
// commit (M9, decision 59).

import { run } from '../lib/adapter.mjs';
import { handleApprove } from '../lib/handlers.mjs';

export default async function approve(context, req) {
  await run(handleApprove, context, req);
}
