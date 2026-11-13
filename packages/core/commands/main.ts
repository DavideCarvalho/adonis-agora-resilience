import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import {
  ResilienceCircuitsList,
  ResilienceCircuitsReset,
  ResilienceCircuitsShow,
} from './circuits.js';
import {
  ResilienceBulkheadsList,
  ResilienceBulkheadsShow,
  ResilienceRateLimitersList,
  ResilienceRateLimitersShow,
} from './limits.js';
import { ResiliencePoliciesList } from './policies.js';
import ResilienceDoctor from './resilience_doctor.js';

/**
 * The commands barrel for `@adonis-agora/resilience`, registered in `adonisrc.ts` with
 * `rcFile.addCommand('@adonis-agora/resilience/commands')` (done by `configure`).
 */
const loader = new ListLoader([
  AgoraDoctor,
  ResilienceDoctor,
  ResiliencePoliciesList,
  ResilienceCircuitsList,
  ResilienceCircuitsShow,
  ResilienceCircuitsReset,
  ResilienceBulkheadsList,
  ResilienceBulkheadsShow,
  ResilienceRateLimitersList,
  ResilienceRateLimitersShow,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
