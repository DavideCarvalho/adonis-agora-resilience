import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import ResilienceCircuits from './circuits.js';
import ResilienceReset from './reset.js';
import ResilienceDoctor from './resilience_doctor.js';

/**
 * The commands barrel for `@adonis-agora/resilience`, registered in `adonisrc.ts` with
 * `rcFile.addCommand('@adonis-agora/resilience/commands')` (done by `configure`).
 */
const loader = new ListLoader([AgoraDoctor, ResilienceCircuits, ResilienceDoctor, ResilienceReset]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
