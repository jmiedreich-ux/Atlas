// The deployable: the Function app Static Web Apps actually ships.
//
// Decision 5 chose Static Web Apps over an App Service for exactly this — managed Functions ship
// in the same deployable, behind the same auth as the site, on the Free tier. So the shape of the
// `api/` directory is part of the contract, not an implementation detail, and the tests below hold
// it: two functions and no third, POST only, no dependencies, and adapters thin enough that
// nothing is decided in them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(REPO_ROOT, 'api');

function json(...segments) {
  return JSON.parse(readFileSync(path.join(API_DIR, ...segments), 'utf8'));
}

// Every directory under api/ that Azure Functions would treat as a function: one holding a
// function.json. `lib/` is not one, and that is what keeps the shared modules out of the runtime's
// way.
function functionDirs() {
  return readdirSync(API_DIR)
    .filter((name) => statSync(path.join(API_DIR, name)).isDirectory())
    .filter((name) => {
      try {
        return statSync(path.join(API_DIR, name, 'function.json')).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

test('decision 35: the deployable holds exactly three functions', () => {
  // Amended for M8: a third Function, `deployment-transition`, joins `acceptance` and `answer`.
  // `functionDirs()` sorts alphabetically, and `'answer' < 'deployment-transition'` there, so the
  // new entry lands last, not in creation order.
  assert.deepEqual(functionDirs(), ['acceptance', 'answer', 'deployment-transition']);
});

test('the Function app declares no dependencies at all, so there are none to justify', () => {
  // The plan allows a managed Function its own dependencies with a justification each. It has
  // none: `node:crypto` signs the App's assertion, so there is no `jsonwebtoken` and no
  // `@azure/functions` to keep patched in something that ships beside the site on every build.
  const manifest = json('package.json');
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(manifest.devDependencies ?? {}), []);
  assert.equal(manifest.type, 'module', 'the adapters are ESM and Node needs telling');
});

test("the generator's own two runtime dependencies are still the only ones", () => {
  // The api manifest is a second package.json in this repository, and the test that pins decision
  // 9's two dependencies reads the first. This is the other half of that guard.
  const root = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(root.dependencies).sort(), ['@11ty/eleventy', 'markdown-it']);
});

test('host.json is a v2 Functions host, which is what Static Web Apps runs', () => {
  const host = json('host.json');
  assert.equal(host.version, '2.0');
});

// Amended for M8: 'deployment-transition' joins the two functions this loop already covered.
for (const name of ['answer', 'acceptance', 'deployment-transition']) {
  test(`${name}: the binding accepts POST and nothing else`, () => {
    const binding = json(name, 'function.json');
    const trigger = binding.bindings.find((b) => b.type === 'httpTrigger');
    assert.ok(trigger, 'there is no HTTP trigger');
    assert.deepEqual(trigger.methods, ['post']);
    assert.equal(trigger.route, name, `the route must be /api/${name}`);
    // Static Web Apps does the authenticating and injects the principal; a function key would be
    // a second, weaker credential for the same door.
    assert.equal(trigger.authLevel, 'anonymous');
    assert.ok(binding.bindings.some((b) => b.type === 'http' && b.direction === 'out'));
  });

  test(`${name}: the adapter decides nothing — it hands the request to the handler`, async () => {
    const source = readFileSync(path.join(API_DIR, name, 'index.mjs'), 'utf8');
    // Nothing about who may write, what may be written, or where it goes may live in a file that
    // no test can reach except through the Functions host.
    assert.ok(!/userRoles|author|ATLAS_GITHUB|contents\//.test(source), `${name}/index.mjs decides something`);
    assert.match(source, /from '\.\.\/lib\/handlers\.mjs'/);
  });
}

test('answer: the adapter maps a handler response onto the Functions context', async () => {
  const { default: handler } = await import('../api/answer/index.mjs');
  const context = {};
  // No credential and no principal: the request is refused before anything is attempted, which is
  // exactly the path that must work on a deployment where the App does not exist yet.
  await handler(context, { method: 'POST', headers: {}, body: {} });

  assert.equal(context.res.status, 401);
  assert.match(context.res.headers['Content-Type'], /application\/json/);
  assert.equal(JSON.parse(context.res.body).error, 'unauthenticated');
});

test('acceptance: the adapter maps a handler response onto the Functions context', async () => {
  const { default: handler } = await import('../api/acceptance/index.mjs');
  const context = {};
  await handler(context, { method: 'POST', headers: {}, body: {} });
  assert.equal(context.res.status, 401);
});

test('deployment-transition: the adapter maps a handler response onto the Functions context', async () => {
  const { default: handler } = await import('../api/deployment-transition/index.mjs');
  const context = {};
  await handler(context, { method: 'POST', headers: {}, body: {} });
  assert.equal(context.res.status, 401);
});

test('the adapters read the credential from the environment, never from the request', async () => {
  // A deployment with the App configured but a caller who is not signed in must still be a 401,
  // and must still make no request. This is the same path with the slot full.
  const before = { ...process.env };
  try {
    process.env.ATLAS_GITHUB_APP_ID = '1';
    process.env.ATLAS_GITHUB_APP_INSTALLATION_ID = '2';
    process.env.ATLAS_GITHUB_APP_PRIVATE_KEY = 'not-a-key';
    process.env.ATLAS_REPO = 'an-owner/a-repo';

    const { default: handler } = await import('../api/answer/index.mjs');
    const context = {};
    await handler(context, { method: 'POST', headers: {}, body: {} });
    assert.equal(context.res.status, 401, 'a signed-out caller got past the door');
  } finally {
    for (const key of ['ATLAS_GITHUB_APP_ID', 'ATLAS_GITHUB_APP_INSTALLATION_ID', 'ATLAS_GITHUB_APP_PRIVATE_KEY', 'ATLAS_REPO']) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test('the action offers the deployable to a consuming workflow, and says where it lands', () => {
  const action = readFileSync(path.join(REPO_ROOT, 'action.yml'), 'utf8');
  // A project cannot point `api_location` at a directory inside the action's own checkout, so the
  // action has to put one where the workflow can name it.
  assert.match(action, /api-dir:/);
  assert.match(action, /outputs:/);
  assert.match(action, /api-path:/);
});

test('nothing in the deployable carries a credential, or a place to put one', () => {
  const walk = (dir) => {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...walk(full));
      else found.push(full);
    }
    return found;
  };

  const files = walk(API_DIR);
  assert.ok(files.length >= 8, `expected to scan the deployable, saw ${files.length} files`);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/BEGIN (RSA )?PRIVATE KEY/.test(text), `${file} contains key material`);
    assert.ok(!/gh[psoru]_[A-Za-z0-9]{16,}/.test(text), `${file} contains a GitHub token`);
  }
});
