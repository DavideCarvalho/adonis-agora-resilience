import app from '@adonisjs/core/services/app';

import { ResilienceService } from '../resilience_service.js';

/**
 * Returns a singleton instance of the {@link ResilienceService} class from the
 * container. The same singleton the provider binds — use this import instead of
 * resolving `ResilienceService` from the container by hand.
 */
let resilience: ResilienceService;

await app.booted(async () => {
  resilience = await app.container.make(ResilienceService);
});

export { resilience as default };
