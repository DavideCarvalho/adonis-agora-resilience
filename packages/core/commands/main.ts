import { ListLoader } from '@adonisjs/core/ace';
import ResilienceCircuits from './circuits.js';
import ResilienceReset from './reset.js';

/**
 * The commands barrel for `@adonis-agora/resilience`, registered in `adonisrc.ts` with
 * `rcFile.addCommand('@adonis-agora/resilience/commands')` (done by `configure`).
 */
const loader = new ListLoader([ResilienceCircuits, ResilienceReset]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
