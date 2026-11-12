// agora-doctor runner v1 — keep identical across libs
/**
 * The `node ace agora:doctor` runner shared by every `@adonis-agora/*` lib. Each lib ships an
 * identical copy of this file (no lib depends on another): the contract is a data-only container
 * value `'agora.doctor'`, the checks are registered by each lib's provider, and whichever lib's
 * command Ace keeps runs every check.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';

// ── contract ─────────────────────────────────────────────────────────────────────────────────

/** The slice of the AdonisJS application the runner and the checks use. */
export interface DoctorApp {
  readonly container: {
    hasBinding(binding: string): boolean;
    bindValue(binding: string, value: unknown): void;
    make(binding: string): Promise<unknown>;
  };
  readonly inProduction: boolean;
  readonly nodeEnvironment?: string;
  makePath(...paths: string[]): string;
}

/** Bound as a VALUE under `'agora.doctor'`. Data only. */
export interface AgoraDoctorRegistry {
  readonly version: 1;
  readonly checks: AgoraDoctorCheck[];
}

export type AgoraDoctorStatus = 'ok' | 'warn' | 'error' | 'skip';

export interface AgoraDoctorCheck {
  /** `'<lib>.<kebab>'`, unique, frozen for 1.x. */
  id: string;
  /** `'durable'` (also the package suffix: `@adonis-agora/durable`). */
  lib: string;
  title: string;
  /** `'cheap'` (default): config/env/files only. `'deep'`: DB/Redis/network, only with `--deep`. */
  cost?: 'cheap' | 'deep';
  run(
    app: ApplicationService,
  ): AgoraDoctorResult | AgoraDoctorResult[] | Promise<AgoraDoctorResult | AgoraDoctorResult[]>;
}

export interface AgoraDoctorResult {
  status: AgoraDoctorStatus;
  /** One line, no secrets, no stack. */
  message: string;
  /** One line: the exact change. */
  fix?: string;
  /** Absolute URL to the lib docs. */
  docs?: string;
}

export const AGORA_DOCTOR_BINDING = 'agora.doctor';

/**
 * Add `checks` to the `'agora.doctor'` registry, creating it when absent. Call from a provider's
 * `register()`: an existing registry is read in a microtask, which settles before any provider boots.
 * A registry of another version is left alone; a duplicate id is skipped.
 */
export function registerDoctorChecks(app: DoctorApp, checks: AgoraDoctorCheck[]): void {
  const add = (registry: unknown) => {
    const r = registry as AgoraDoctorRegistry | undefined;
    if (r?.version !== 1 || !Array.isArray(r.checks)) return;
    for (const check of checks) {
      if (r.checks.some((c) => c.id === check.id)) continue;
      r.checks.push(check);
    }
  };
  if (!app.container.hasBinding(AGORA_DOCTOR_BINDING)) {
    const registry: AgoraDoctorRegistry = { version: 1, checks: [] };
    app.container.bindValue(AGORA_DOCTOR_BINDING, registry);
    add(registry);
    return;
  }
  void app.container.make(AGORA_DOCTOR_BINDING).then(add, () => {});
}

// ── report ───────────────────────────────────────────────────────────────────────────────────

export interface DoctorResultRow extends AgoraDoctorResult {
  id: string;
  lib: string;
  title: string;
  ms: number;
}

export interface DoctorReport {
  version: 1;
  env: string;
  summary: Record<AgoraDoctorStatus, number>;
  libs: { lib: string; package: string; version: string | null }[];
  results: DoctorResultRow[];
}

export interface DoctorOptions {
  /** Only these libs. */
  libs?: string[];
  /** Also run `deep` checks. */
  deep?: boolean;
  /** Only this check id. */
  only?: string;
  /** Do not read the registry (the app was not booted): built-in checks of the installed libs only. */
  noBoot?: boolean;
}

/** The doctor itself cannot run (exit code 2). */
export class DoctorUsageError extends Error {}

const SCOPE = '@adonis-agora/';

/** The fields of a package.json the doctor reads. */
interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/** Find `node_modules/<name>/package.json` from `from` upward. */
function findPackage(name: string, from: string): { dir: string; json: PackageJson } | null {
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) {
      try {
        return {
          dir: realpathSync(dirname(candidate)),
          json: JSON.parse(readFileSync(candidate, 'utf8')),
        };
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) return null;
    dir = parent;
  }
}

// A small semver range matcher: `^ ~ >= > <= < =`, `x`/`*`, hyphen-free AND sets, `||` unions.
type Version = [number, number, number, string[]];

function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(text.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split('.') : []];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  const [pa, pb] = [a[3], b[3]];
  if (pa.length === 0 || pb.length === 0) return pb.length - pa.length;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [x, y] = [pa[i], pb[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [nx, ny] = [Number(x), Number(y)];
    if (x !== y) return Number.isNaN(nx) || Number.isNaN(ny) ? (x < y ? -1 : 1) : nx - ny;
  }
  return 0;
}

type Comparator = { op: string; v: Version };

function expand(token: string): Comparator[] | null {
  const m =
    /^(\^|~|>=|<=|>|<|=)?\s*v?([0-9x*]+)(?:\.([0-9x*]+))?(?:\.([0-9x*]+))?(-[0-9A-Za-z.-]+)?$/.exec(
      token,
    );
  if (!m) return null;
  const op = m[1] ?? '';
  const wild = (s: string | undefined) => s === undefined || s === 'x' || s === '*';
  const [ma, mi, pa] = [m[2], m[3], m[4]];
  const pre = m[5] ? m[5].slice(1).split('.') : [];
  if (wild(ma)) return [];
  const major = Number(ma);
  if (wild(mi))
    return [
      { op: '>=', v: [major, 0, 0, []] },
      { op: '<', v: [major + 1, 0, 0, ['0']] },
    ];
  const minor = Number(mi);
  if (wild(pa)) {
    return [
      { op: '>=', v: [major, minor, 0, []] },
      { op: '<', v: [major, minor + 1, 0, ['0']] },
    ];
  }
  const v: Version = [major, minor, Number(pa), pre];
  if (op === '^') {
    const upper: Version =
      major > 0
        ? [major + 1, 0, 0, ['0']]
        : minor > 0
          ? [0, minor + 1, 0, ['0']]
          : [0, 0, v[2] + 1, ['0']];
    return [
      { op: '>=', v },
      { op: '<', v: upper },
    ];
  }
  if (op === '~')
    return [
      { op: '>=', v },
      { op: '<', v: [major, minor + 1, 0, ['0']] },
    ];
  return [{ op: op === '' ? '=' : op, v }];
}

/** Whether `version` satisfies `range` (npm semantics, including the prerelease rule). */
export function satisfies(version: string, range: string): boolean | null {
  const v = parseVersion(version);
  if (!v) return null;
  for (const part of range.split('||')) {
    const tokens = part
      .trim()
      .replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean);
    const set: Comparator[] = [];
    let valid = true;
    for (const t of tokens) {
      const c = expand(t);
      if (!c) valid = false;
      else set.push(...c);
    }
    if (!valid) continue;
    const ok = set.every(({ op, v: c }) => {
      const r = compare(v, c);
      return op === '>='
        ? r >= 0
        : op === '>'
          ? r > 0
          : op === '<='
            ? r <= 0
            : op === '<'
              ? r < 0
              : r === 0;
    });
    // A prerelease only matches a set that names a prerelease of the same version.
    const preOk =
      v[3].length === 0 ||
      set.some(
        ({ v: c }) =>
          c[3].length > 0 && c[3][0] !== '0' && c[0] === v[0] && c[1] === v[1] && c[2] === v[2],
      );
    if (ok && preOk) return true;
  }
  return false;
}

/** Built-in `<lib>.peers`: every peer of the lib resolves and is in range. */
function peersCheck(lib: string, app: DoctorApp): AgoraDoctorResult[] {
  const pkg = findPackage(SCOPE + lib, app.makePath());
  if (!pkg) return [{ status: 'skip', message: `${SCOPE}${lib} is not installed in the app root` }];
  const peers: Record<string, string> = pkg.json.peerDependencies ?? {};
  const meta: Record<string, { optional?: boolean }> = pkg.json.peerDependenciesMeta ?? {};
  const out: AgoraDoctorResult[] = [];
  for (const [name, range] of Object.entries(peers)) {
    const found = findPackage(name, pkg.dir) ?? findPackage(name, app.makePath());
    if (!found) {
      if (!meta[name]?.optional) {
        out.push({
          status: 'error',
          message: `peer ${name} (${range}) is not installed`,
          fix: `Install ${name}@"${range}"`,
        });
      }
      continue;
    }
    const ok = satisfies(String(found.json.version), range);
    if (ok === false) {
      out.push({
        status: meta[name]?.optional ? 'warn' : 'error',
        message: `peer ${name}@${found.json.version} is outside ${range}`,
        fix: `Install ${name}@"${range}"`,
      });
    }
  }
  return out.length > 0 ? out : [{ status: 'ok', message: 'every installed peer is in range' }];
}

/** Built-in `<lib>.agora-siblings`: no mixing a 1.0 rc with 0.x siblings or two rc numbers. */
function siblingsCheck(lib: string, installed: Map<string, string | null>): AgoraDoctorResult {
  const own = installed.get(lib);
  if (!own) return { status: 'skip', message: 'version unknown' };
  const rc = (v: string) => /^1\.0\.0-rc\.(\d+)/.exec(v)?.[1];
  const ownRc = rc(own);
  const clashes: string[] = [];
  for (const [other, version] of installed) {
    if (other === lib || !version) continue;
    const otherRc = rc(version);
    if (ownRc !== undefined && version.startsWith('0.')) clashes.push(`${other}@${version}`);
    else if (ownRc !== undefined && otherRc !== undefined && otherRc !== ownRc)
      clashes.push(`${other}@${version}`);
  }
  return clashes.length === 0
    ? { status: 'ok', message: `${own} matches the other @adonis-agora libs` }
    : {
        status: 'warn',
        message: `${own} is installed with ${clashes.join(', ')}`,
        fix: 'Install the same release of every @adonis-agora lib',
      };
}

/** Every `@adonis-agora/*` package listed in the app's package.json, with its installed version. */
function installedLibs(app: DoctorApp): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let manifest: PackageJson = {};
  try {
    manifest = JSON.parse(readFileSync(app.makePath('package.json'), 'utf8'));
  } catch {}
  for (const field of ['dependencies', 'devDependencies'] as const) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (!name.startsWith(SCOPE)) continue;
      const lib = name.slice(SCOPE.length);
      out.set(lib, (findPackage(name, app.makePath())?.json.version as string | undefined) ?? null);
    }
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runOne(
  check: AgoraDoctorCheck,
  app: DoctorApp,
  verbose: boolean,
): Promise<DoctorResultRow[]> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const timeout = check.cost === 'deep' ? 15_000 : 5_000;
    const results = await withTimeout(
      Promise.resolve().then(() => check.run(app as unknown as ApplicationService)),
      timeout,
    );
    const list = Array.isArray(results) ? results : [results];
    const took = ms();
    return list.map((r) => ({ id: check.id, lib: check.lib, title: check.title, ...r, ms: took }));
  } catch (error) {
    const message =
      error instanceof Error
        ? verbose && error.stack
          ? error.stack
          : error.message
        : String(error);
    return [
      { id: check.id, lib: check.lib, title: check.title, status: 'error', message, ms: ms() },
    ];
  }
}

async function mapLibs<T>(libs: string[], fn: (lib: string) => Promise<T>): Promise<T[]> {
  const out = new Array<T>(libs.length);
  let next = 0;
  const worker = async () => {
    while (next < libs.length) {
      const i = next++;
      out[i] = await fn(libs[i] as string);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, libs.length) }, worker));
  return out;
}

/** Run the doctor: registered checks plus `<lib>.registered`, `<lib>.peers`, `<lib>.agora-siblings`. */
export async function runDoctor(
  app: DoctorApp,
  options: DoctorOptions = {},
  verbose = false,
): Promise<DoctorReport> {
  let registered: AgoraDoctorCheck[] = [];
  if (!options.noBoot && app.container.hasBinding(AGORA_DOCTOR_BINDING)) {
    const registry = (await app.container.make(AGORA_DOCTOR_BINDING)) as AgoraDoctorRegistry;
    if (registry?.version !== 1) {
      throw new DoctorUsageError(
        `unknown '${AGORA_DOCTOR_BINDING}' registry version ${String(registry?.version)}`,
      );
    }
    registered = registry.checks;
  }
  const installed = installedLibs(app);
  const libs = new Set(registered.map((c) => c.lib));
  if (options.noBoot) for (const lib of installed.keys()) libs.add(lib);

  const builtIns: AgoraDoctorCheck[] = [...libs].flatMap((lib) => [
    ...(options.noBoot
      ? []
      : [
          {
            id: `${lib}.registered`,
            lib,
            title: 'Provider registered',
            run: () => ({ status: 'ok' as const, message: 'registered in adonisrc.ts' }),
          },
        ]),
    { id: `${lib}.peers`, lib, title: 'Peer dependencies', run: () => peersCheck(lib, app) },
    {
      id: `${lib}.agora-siblings`,
      lib,
      title: 'Agora release train',
      run: () => siblingsCheck(lib, installed),
    },
  ]);
  let checks = [...builtIns, ...registered];
  const knownIds = new Set(checks.map((c) => c.id));
  if (options.only !== undefined && !knownIds.has(options.only)) {
    throw new DoctorUsageError(`no check has the id "${options.only}"`);
  }
  checks = checks.filter(
    (c) =>
      (options.libs === undefined || options.libs.includes(c.lib)) &&
      (options.only === undefined || c.id === options.only) &&
      (c.cost !== 'deep' || options.deep === true || options.only === c.id),
  );
  const byLib = new Map<string, AgoraDoctorCheck[]>();
  for (const c of checks) byLib.set(c.lib, [...(byLib.get(c.lib) ?? []), c]);
  const order = [...byLib.keys()].sort();
  const perLib = await mapLibs(order, async (lib) => {
    const rows: DoctorResultRow[] = [];
    for (const c of byLib.get(lib) ?? []) rows.push(...(await runOne(c, app, verbose)));
    return rows;
  });
  const results = perLib.flat();
  const summary: Record<AgoraDoctorStatus, number> = { ok: 0, warn: 0, error: 0, skip: 0 };
  for (const r of results) summary[r.status] += 1;
  return {
    version: 1,
    env: app.nodeEnvironment ?? (app.inProduction ? 'production' : 'development'),
    summary,
    libs: order.map((lib) => ({
      lib,
      package: SCOPE + lib,
      version: installed.get(lib) ?? findPackage(SCOPE + lib, app.makePath())?.json.version ?? null,
    })),
    results,
  };
}

/** `0` no error, `1` an error (or a warning with `strict`). */
export function exitCodeOf(report: DoctorReport, strict = false): 0 | 1 {
  return report.summary.error > 0 || (strict && report.summary.warn > 0) ? 1 : 0;
}

export interface RenderColors {
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  dim(text: string): string;
}

const plain: RenderColors = { green: (t) => t, yellow: (t) => t, red: (t) => t, dim: (t) => t };

/** Human output. `symbols: false` (no TTY) prints `ok` / `warn` / `error` instead of ✔ ! ✖. */
export function renderHuman(
  report: DoctorReport,
  opts: { colors?: RenderColors; symbols?: boolean; verbose?: boolean } = {},
): string {
  const c = opts.colors ?? plain;
  const sym = opts.symbols !== false;
  const mark = (s: AgoraDoctorStatus) =>
    s === 'ok'
      ? c.green(sym ? '✔' : 'ok')
      : s === 'warn'
        ? c.yellow(sym ? '!' : 'warn')
        : s === 'error'
          ? c.red(sym ? '✖' : 'error')
          : c.dim(sym ? '-' : 'skip');
  const lines = [
    `@adonis-agora doctor · ${report.env} · ${report.libs.length} libs · ${report.results.length} checks`,
  ];
  for (const { lib, version } of report.libs) {
    lines.push('', `${lib}${version ? ` ${version}` : ''}`);
    for (const r of report.results) {
      if (r.lib !== lib || (r.status === 'skip' && !opts.verbose)) continue;
      lines.push(`  ${mark(r.status)} ${r.title}`);
      if (r.status !== 'ok') {
        lines.push(`    ${r.message}`);
        if (r.fix) lines.push(`    fix: ${r.fix}`);
        if (r.docs) lines.push(`    docs: ${r.docs}`);
      }
    }
  }
  const { ok, warn, error, skip } = report.summary;
  const skipped = skip > 0 && !opts.verbose ? `   (skipped ${skip}, run with --verbose)` : '';
  lines.push(
    '',
    `${report.results.length} checks: ${ok} ok · ${warn} warn · ${error} error${skipped}`,
  );
  return lines.join('\n');
}
