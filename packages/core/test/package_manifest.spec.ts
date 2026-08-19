import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `engines.node` declares the range of Node versions a package supports. Renovate is configured
 * with a global `rangeStrategy: "pin"`, which — left unguarded — rewrites that range into a single
 * exact version, so a published package would refuse to install on every other Node release.
 *
 * `renovate.json` opts `engines` out of updates. This is the backstop that fails if that rule is
 * ever dropped and a pinned value lands anyway.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface Manifest {
  path: string;
  name: string;
  private: boolean;
  engines?: Record<string, string>;
}

/** The root manifest plus every workspace package manifest. */
function workspaceManifests(): Manifest[] {
  const files = [join(repoRoot, 'package.json')];
  const packagesDir = join(repoRoot, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(packagesDir, entry.name, 'package.json');
      if (existsSync(manifest)) files.push(manifest);
    }
  }
  return files.map((file) => {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    return {
      path: relative(repoRoot, file),
      name: json.name,
      private: json.private === true,
      engines: json.engines,
    };
  });
}

/** A bare version — `26.7.0`, `v26.7.0`, `=26.7.0` — with no range comparator. */
const PINNED_EXACT = /^[v=]{0,2}\d+(\.\d+)*$/;
/** At least one token that widens a version into a range. */
const RANGE_COMPARATOR = /(>=|<=|>|<|\^|~|\|\||\s-\s|\.x|\*)/;

const manifests = workspaceManifests();
const publishable = manifests.filter((m) => !m.private);

describe('workspace manifests', () => {
  it('finds the publishable package to check', () => {
    expect(publishable.map((m) => m.name)).toContain('@adonis-agora/resilience');
  });

  // Every manifest that declares engines.node, publishable or not — a pinned root is wrong too.
  const withEngines = manifests.filter((m) => typeof m.engines?.node === 'string');

  it('some manifest declares engines.node', () => {
    expect(withEngines.length).toBeGreaterThan(0);
  });

  it.each(withEngines)('$path declares engines.node as a range', (manifest) => {
    const node = (manifest.engines as Record<string, string>).node.trim();
    const hint = [
      `${manifest.path} has engines.node "${node}".`,
      'It must be a supported RANGE (e.g. ">=20.6.0"), not a single pinned version:',
      'a pin makes the package uninstallable on every other Node release.',
      'Check the renovate.json engines rule.',
    ].join(' ');

    expect(PINNED_EXACT.test(node), hint).toBe(false);
    expect(RANGE_COMPARATOR.test(node), hint).toBe(true);
  });
});

describe('renovate config', () => {
  const renovate = join(repoRoot, 'renovate.json');

  it('disables updates to engines', () => {
    // Without this rule the global rangeStrategy "pin" rewrites engines.node to an exact version.
    const config = JSON.parse(readFileSync(renovate, 'utf8'));
    const rule = (config.packageRules ?? []).find((r: { matchDepTypes?: string[] }) =>
      r.matchDepTypes?.includes('engines'),
    );
    expect(rule, 'renovate.json needs a packageRule matching depType "engines"').toBeDefined();
    expect(rule.enabled).toBe(false);
  });
});
