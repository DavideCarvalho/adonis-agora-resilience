/**
 * The `agora:doctor` runner (`src/doctor/agora_doctor.ts`) is copied verbatim into every
 * `@adonis-agora/*` lib, and @adonis-agora/durable holds the reference copy. Fail when this copy
 * differs from durable's default branch (or the URL given as the first argument). Until durable ships the runner (404), report and pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCAL = join(
  import.meta.dirname,
  '..',
  'packages',
  'core',
  'src',
  'doctor',
  'agora_doctor.ts',
);
const REFERENCE =
  process.argv[2] ??
  'https://raw.githubusercontent.com/DavideCarvalho/adonis-agora-durable/master/packages/adonis/src/doctor/agora_doctor.ts';

const local = readFileSync(LOCAL, 'utf8');
if (!local.startsWith('// agora-doctor runner v1 — keep identical across libs')) {
  console.error(`${LOCAL} lost its "agora-doctor runner v1" header`);
  process.exit(1);
}

let response;
try {
  response = await fetch(REFERENCE);
} catch (error) {
  console.warn(`check:doctor-runner: could not reach ${REFERENCE} (${error.message}); skipped`);
  process.exit(0);
}
if (response.status === 404) {
  console.warn(`check:doctor-runner: no reference runner at ${REFERENCE} yet; skipped`);
  process.exit(0);
}
if (!response.ok) {
  console.warn(`check:doctor-runner: ${REFERENCE} answered ${response.status}; skipped`);
  process.exit(0);
}
const reference = await response.text();
if (reference === local) {
  console.log('check:doctor-runner: identical to the reference runner');
  process.exit(0);
}
const a = local.split('\n');
const b = reference.split('\n');
const line = a.findIndex((text, i) => text !== b[i]);
console.error(
  `check:doctor-runner: ${LOCAL} differs from ${REFERENCE} (first difference at line ${line + 1}).\n` +
    'Copy the reference file over this one: the runner must be identical in every lib.',
);
process.exit(1);
