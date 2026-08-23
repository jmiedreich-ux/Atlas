// Placing the write-back Function where a workflow can name it as `api_location`.
//
// This is a second destructive act on a caller-supplied path, and this repository has already
// shipped one hole in the first (`src/outdir.mjs`, and the comment at the top of it). So it reuses
// that guard rather than growing a weaker second one, and it lives in a module with tests rather
// than in a shell block inside `action.yml`, where nothing could reach it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { placeApi } from '../src/place-api.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARENA = path.join(REPO_ROOT, '.tmp-tests', 'place-api');

let sequence = 0;

function project() {
  const root = path.join(ARENA, `case-${(sequence += 1)}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, 'docs', 'features'), { recursive: true });
  writeFileSync(path.join(root, 'atlas.config.json'), '{}\n');
  writeFileSync(path.join(root, 'ROADMAP.md'), '# Roadmap\n');
  return root;
}

// The cases below this line are the shape where the project IS the checkout — one repository whose
// root carries `atlas.config.json`. That is the one live consumer's layout, and it is the layout in
// which a guard measuring against the project and a guard measuring against the checkout agree,
// which is exactly why it hid the bug the section at the bottom of this file covers. `checkoutRoot`
// is passed explicitly rather than left to default, so these tests say which directory they mean
// instead of depending on where the suite was run from.
function refusal(root, apiDir, outDir) {
  try {
    placeApi(root, apiDir, outDir, { checkoutRoot: root });
    return null;
  } catch (error) {
    return error.message;
  }
}

test('place-api: the deployable arrives whole, and is a Function app when it lands', () => {
  const root = project();
  // `placeApi` answers with a path relative to the project — see the api_location test below — so
  // reading the files back means resolving it against the project, exactly as the deploy step does
  // against the checkout.
  const where = path.join(
    root,
    placeApi(root, path.join(root, '.atlas-api'), path.join(root, '.atlas-out'), { checkoutRoot: root }),
  );

  assert.ok(existsSync(path.join(where, 'host.json')));
  assert.ok(existsSync(path.join(where, 'answer', 'function.json')));
  assert.ok(existsSync(path.join(where, 'acceptance', 'function.json')));
  assert.ok(existsSync(path.join(where, 'lib', 'handlers.mjs')));
  assert.equal(JSON.parse(readFileSync(path.join(where, 'package.json'), 'utf8')).type, 'module');
});

test('place-api: it replaces what was there, so a removed file does not survive the next run', () => {
  const root = project();
  const target = path.join(root, '.atlas-api');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'left-over.mjs'), '// from a previous version of Atlas\n');

  placeApi(root, target, path.join(root, '.atlas-out'), { checkoutRoot: root });
  assert.ok(!existsSync(path.join(target, 'left-over.mjs')), 'a stale file survived the placement');
});

test('place-api: it refuses to write over the output directory, in either direction', () => {
  const root = project();
  const out = path.join(root, '.atlas-out');

  assert.match(refusal(root, out, out), /output/i);
  assert.match(refusal(root, path.join(out, 'api'), out), /output/i);
  assert.match(refusal(root, path.dirname(out) === root ? root : out, out), /./);
});

test("place-api: it refuses every path the build reads — the guard is src/outdir.mjs's, not a second one", () => {
  const root = project();
  const out = path.join(root, '.atlas-out');

  for (const forbidden of [root, path.join(root, 'docs'), path.join(root, 'ROADMAP.md'), REPO_ROOT, path.join(REPO_ROOT, 'api')]) {
    assert.ok(refusal(root, forbidden, out), `the guard allowed ${forbidden}`);
  }
});

test('place-api: it refuses the filesystem root, which is the one that costs everything', () => {
  const root = project();
  assert.ok(refusal(root, path.parse(root).root, path.join(root, '.atlas-out')));
});

test('place-api: an empty destination places nothing and says so, rather than guessing one', () => {
  const root = project();
  assert.equal(placeApi(root, '', path.join(root, '.atlas-out')), '');
});

// --- I7: what the action hands to the deploy step -------------------------------------------------

test('place-api: the path it reports is relative to the checkout, because api_location is', () => {
  // `Azure/static-web-apps-deploy` runs in a container with the checkout mounted at
  // /github/workspace and reads `api_location` against it. An absolute path from the runner does
  // not resolve inside that container — and `app_location` on the line above it in every example
  // is read the same way, so the two would not even have been in the same frame of reference.
  const root = project();
  const where = placeApi(root, path.join(root, '.atlas-api'), path.join(root, '.atlas-out'), {
    checkoutRoot: root,
  });

  assert.equal(where, '.atlas-api');
  assert.ok(!path.isAbsolute(where), `the deploy step would be handed ${where}`);
  assert.ok(existsSync(path.join(root, where, 'host.json')), 'the path does not resolve under the project');
});

test('place-api: a nested destination is reported with forward slashes, whatever the platform uses', () => {
  const root = project();
  const where = placeApi(root, path.join(root, 'build', 'api'), path.join(root, '.atlas-out'), {
    checkoutRoot: root,
  });
  assert.equal(where, 'build/api');
});

test('place-api: a destination outside the checkout fails loudly rather than at deploy time', () => {
  // It would place the files perfectly well and then be unusable as an `api_location`, which is a
  // failure that surfaces as a deploy that quietly ships no API.
  const root = project();
  const outside = path.join(ARENA, `outside-${sequence}`);
  const message = refusal(root, outside, path.join(root, '.atlas-out'));
  assert.ok(message, 'a destination outside the checkout was allowed');
  assert.match(message, /outside/i);
});

// --- the checkout, which is not always the project -------------------------------------------------
//
// `api_location` is resolved by the deploy action against the CHECKOUT, and this guard measured
// against the PROJECT. Those are the same directory only when a project happens to sit at the
// repository root — which the one live consumer does, so the distinction was invisible there.
// Atlas's own CI builds `fixture/` and places the API at `.atlas-api` in the checkout root, and
// that is the shape nothing covered until the action's own CI refused it.

// A checkout with the project in a subdirectory of it, the way `.github/workflows/test.yml` is laid
// out.
function checkout() {
  const root = path.join(ARENA, `checkout-${(sequence += 1)}`);
  rmSync(root, { recursive: true, force: true });
  const projectRoot = path.join(root, 'fixture');
  mkdirSync(path.join(projectRoot, 'docs', 'features'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'atlas.config.json'), '{}\n');
  writeFileSync(path.join(projectRoot, 'ROADMAP.md'), '# Roadmap\n');
  return { root, projectRoot };
}

test('place-api: a project in a subdirectory places the API at the checkout root', () => {
  // Exactly what the action's own CI runs, and exactly what the guard refused:
  //   project  <checkout>/fixture
  //   api-dir  <checkout>/.atlas-api
  // Outside the project, inside the checkout, and entirely legitimate.
  const { root, projectRoot } = checkout();

  const where = placeApi(projectRoot, path.join(root, '.atlas-api'), path.join(root, '.atlas-out'), {
    checkoutRoot: root,
  });

  assert.equal(where, '.atlas-api', 'the path handed to api_location is not checkout-relative');
  assert.ok(existsSync(path.join(root, where, 'host.json')));
});

test('place-api: the path is relative to the CHECKOUT, not to the project', () => {
  // The two differ here, which is the whole point: relative to the project this would be
  // `../build/api`, which no api_location can express.
  const { root, projectRoot } = checkout();

  const where = placeApi(projectRoot, path.join(root, 'build', 'api'), path.join(root, '.atlas-out'), {
    checkoutRoot: root,
  });

  assert.equal(where, 'build/api');
  assert.ok(!where.startsWith('..'), `${where} cannot be used as an api_location`);
});

test('place-api: a path outside the CHECKOUT is still refused — that is the real failure', () => {
  const { root, projectRoot } = checkout();

  for (const outside of [path.join(ARENA, `elsewhere-${sequence}`), path.resolve(root, '..', 'elsewhere')]) {
    let message = null;
    try {
      placeApi(projectRoot, outside, path.join(root, '.atlas-out'), { checkoutRoot: root });
    } catch (error) {
      message = error.message;
    }
    assert.ok(message, `${outside} was allowed, and no api_location could name it`);
    assert.match(message, /outside/i);
  }
});

test('place-api: the refusal says which root it measured against, and it is the checkout', () => {
  // The old message named the project and then talked about the checkout, which is what made a
  // wrong guard read as a correct one.
  const { root, projectRoot } = checkout();

  let message = null;
  try {
    placeApi(projectRoot, path.resolve(root, '..', 'elsewhere'), path.join(root, '.atlas-out'), {
      checkoutRoot: root,
    });
  } catch (error) {
    message = error.message;
  }

  assert.ok(message);
  assert.match(message, /outside the checkout/i, `the message does not say what it measured against: ${message}`);
  assert.ok(message.includes(root), `the message does not name the checkout it used: ${message}`);
  // It may still MENTION the project — saying "the project is here, and the API does not have to
  // be inside it" is the sentence that stops the next reader making the same mistake. What it must
  // not do is state the project as the boundary, which is what the old wording did.
  assert.ok(
    !/outside the project/i.test(message),
    `the message still states the project as the rule: ${message}`,
  );
});
