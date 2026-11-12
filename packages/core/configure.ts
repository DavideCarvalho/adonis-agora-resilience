import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @adonis-agora/resilience` — registers the provider and the commands and publishes
 * `config/resilience.ts`.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@adonis-agora/resilience/resilience_provider');
    rcFile.addCommand('@adonis-agora/resilience/commands');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/resilience.stub', {});
}
