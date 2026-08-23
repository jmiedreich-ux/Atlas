// Who the caller is, and whether they may write.
//
// Static Web Apps authenticates every request to a route that requires a role (decision 7:
// nothing is anonymous) and injects `x-ms-client-principal` — base64-encoded JSON carrying the
// identity provider, a stable user id, a display name and the roles the invitation granted.
//
// That header is the only identity this Function accepts. It cannot be set by the caller: Static
// Web Apps strips any inbound copy and writes its own before the request reaches a managed
// Function. A field in the request body naming a user, or a role, is not identity — it is a value
// the caller chose — and nothing here reads the body at all.
//
// Reading the site needs `reader`, and writing needs `author`. Two roles rather than one, so that
// everyone invited to read the records is not thereby able to commit to them.

/**
 * The role a write requires. Deliberately not `reader`.
 *
 * Defined in `./contract.mjs`, which is where a value the generator and the Function both need
 * lives, and re-exported under this module's own name because this is where a reader of the write
 * path looks for it. `src/swa.mjs` puts the same value in the emitted `/api/*` route rule.
 */
export { WRITE_ROLE as AUTHOR_ROLE } from './contract.mjs';

import { WRITE_ROLE as AUTHOR_ROLE } from './contract.mjs';

const HEADER = 'x-ms-client-principal';

/** Every SWA caller carries these, so neither says anything about what a caller may do. */
const AMBIENT_ROLES = new Set(['anonymous', 'authenticated']);

// A commit message and a Markdown record are both line-structured, so an author name that carries
// a newline — or a heading marker — is an author name that can restructure them. Names arrive from
// an identity provider rather than from the caller, but the write path should not depend on that
// being true, and the cost of not depending on it is this function.
function sanitiseName(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[#*_`[\]<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  // A host may hand headers over in any case, and some hand over a Headers object rather than a
  // plain one. Both are read the same way here so no caller has to remember which it has.
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function refuse(status, error, message) {
  return { ok: false, status, error, message };
}

function decodePrincipal(raw) {
  let json;
  try {
    json = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return null;
  }
  // Buffer.from with 'base64' never throws — it discards what it cannot decode — so a string that
  // is not base64 at all arrives here as rubbish rather than as an exception, and it is the JSON
  // parse below that catches it.
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * Decide whether a request may write, from its headers alone.
 *
 * @param {Record<string, string> | Headers} headers - the request's headers.
 * @param {unknown} [_body] - accepted and never read. Present so that every call site passing a
 *   body has somewhere to pass it that provably ignores it; the tests send a body claiming the
 *   `author` role and assert the caller is still refused.
 * @returns {{ ok: true, principal: { author: string, userId: string, roles: string[] } }
 *   | { ok: false, status: number, error: string, message: string }}
 */
// eslint-disable-next-line no-unused-vars
export function authorise(headers, _body) {
  const raw = headerValue(headers, HEADER);

  if (typeof raw !== 'string' || raw.length === 0) {
    return refuse(
      401,
      'unauthenticated',
      `this request carried no ${HEADER} header, so Atlas does not know who is asking. ` +
        `Sign in to the site and try again.`,
    );
  }

  const principal = decodePrincipal(raw);
  if (!principal) {
    return refuse(
      401,
      'unauthenticated',
      `the ${HEADER} header could not be read as an identity. Sign out, sign back in, and try again.`,
    );
  }

  const roles = principal.userRoles;
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== 'string')) {
    return refuse(
      401,
      'unauthenticated',
      `the ${HEADER} header carried no list of roles, so Atlas cannot tell what this account may do.`,
    );
  }

  if (!roles.includes(AUTHOR_ROLE)) {
    const held = roles.filter((role) => !AMBIENT_ROLES.has(role));
    return refuse(
      403,
      'forbidden',
      `writing needs the "${AUTHOR_ROLE}" role and this account holds ` +
        `${held.length > 0 ? held.map((r) => `"${r}"`).join(', ') : 'no role of its own'}. ` +
        `Reading the site needs "reader"; writing to the records is a separate invitation. ` +
        `Grant it in the Static Web App under Role management.`,
    );
  }

  const userId = sanitiseName(principal.userId);
  const details = sanitiseName(principal.userDetails);

  return {
    ok: true,
    principal: {
      // The name a commit and a record will carry. A principal with no display name still commits
      // under something that identifies it, because "answered by" with nothing after it is worse
      // than a user id.
      author: details || (userId ? `user ${userId}` : 'an unnamed Atlas account'),
      userId,
      roles,
    },
  };
}
