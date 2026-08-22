// The one place the Azure Functions host meets Atlas, kept as thin as it can be made.
//
// Everything a request's outcome depends on — who may write, what may be written, where it goes —
// lives in `api/lib/handlers.mjs`, which is ordinary code any test can call. Nothing is decided
// here, because anything decided here would be reachable only by running the Functions host, and
// the whole of this milestone's evidence is tests that run under plain Node.
//
// `authLevel` is `anonymous` in both bindings, which is not the same as unauthenticated: Static
// Web Apps authenticates in front of the Function and injects `x-ms-client-principal`, and a
// function key would be a second, weaker credential for the same door. The role check in
// `api/lib/principal.mjs` is what actually gates the write.

/**
 * Run a handler for the Functions host and put its answer on the context.
 *
 * @param {(request: object, deps: object) => Promise<{ status: number, headers: object, body: object }>} handler
 * @param {object} context - the Functions invocation context.
 * @param {object} req - the Functions HTTP request.
 */
export async function run(handler, context, req) {
  const response = await handler(
    {
      method: req?.method,
      headers: req?.headers ?? {},
      // `body` when the host parsed JSON for us, `rawBody` when it did not. The payload validator
      // takes either and refuses anything that is not an object.
      body: req?.body ?? req?.rawBody,
    },
    {
      // The credential is a deployment setting, and this is the only place it is read from.
      env: process.env,
      fetchImpl: fetch,
      // The one clock read in the whole write path, and it is not about the record: a GitHub App's
      // assertion carries `iat` and `exp`. Nothing that reaches a record derives from it.
      nowSeconds: Math.floor(Date.now() / 1000),
    },
  );

  context.res = {
    status: response.status,
    headers: response.headers,
    body: JSON.stringify(response.body),
  };
}
