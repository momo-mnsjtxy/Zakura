import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import test from 'node:test';

const required = [
  'LICENSE', 'README.md', 'docs/BASELINE.md', 'docs/FEATURE_MATRIX.md',
  'apps/server/package.json', 'apps/web/package.json', 'packages/shared/package.json',
  'packages/core/package.json', 'packages/saas/package.json', 'apps/oauth-bridge/package.json',
  'go/agent/go.mod',
];

test('records immutable upstream baseline and AGPL attribution', async () => {
  const baseline = await readFile('docs/BASELINE.md', 'utf8');
  const license = await readFile('LICENSE', 'utf8');
  const readme = await readFile('README.md', 'utf8');
  assert.match(baseline, /210677c58a700dbaf58dbff86350d46fd7b9a3e1/);
  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(readme, /Sunwuyuan/);
});

test('contains every product package required by the compatibility contract', async () => {
  await Promise.all(required.map((path) => access(path)));
});

test('feature matrix enumerates operational gates instead of claiming untested parity', async () => {
  const matrix = await readFile('docs/FEATURE_MATRIX.md', 'utf8');
  for (const capability of ['Identity and tenancy', 'Agents and chat', 'Models and gateways', 'MCP and skills', 'Runtimes and workspaces', 'Connectors and channels', 'SaaS/admin']) {
    assert.match(matrix, new RegExp(capability));
  }
  assert.doesNotMatch(matrix, /TODO|placeholder/i);
});
