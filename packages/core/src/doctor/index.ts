import { resilienceDoctorChecks } from './checks.js';

export type {
  AgoraDoctorCheck,
  AgoraDoctorReport,
  AgoraDoctorResult,
  AgoraDoctorStatus,
} from './agora_doctor.js';
export { resilienceDoctorChecks } from './checks.js';

/** The resilience doctor checks, read by `agora:doctor --no-boot`. */
export const agoraDoctorChecks = resilienceDoctorChecks();
