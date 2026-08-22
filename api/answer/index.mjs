// POST /api/answer — record an answer to a question in a workstream's register (decisions 35, 37).

import { run } from '../lib/adapter.mjs';
import { handleAnswer } from '../lib/handlers.mjs';

export default async function answer(context, req) {
  await run(handleAnswer, context, req);
}
