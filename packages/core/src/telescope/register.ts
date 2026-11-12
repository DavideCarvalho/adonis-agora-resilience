import { TELESCOPE_EXTENSIONS_BINDING, type TelescopeExtension } from './telescope-sdk.js';

/** The slice of the AdonisJS container {@link registerTelescopeExtension} uses. */
export interface ExtensionsContainer {
  hasBinding(binding: string): boolean;
  bindValue(binding: string, value: unknown): void;
  make(binding: string): Promise<unknown>;
}

/**
 * Add `extension` to the `'agora.telescope.extensions'` container value, creating it when no lib
 * has yet. Call from a provider's `register()`: whatever the provider order, the extension is in the
 * list before any provider boots (an existing value is read in a microtask, which settles before the
 * boot phase starts). Telescope reads the list next to `config.extensions`.
 */
export function registerTelescopeExtension(
  container: ExtensionsContainer,
  extension: TelescopeExtension,
  onError: (error: unknown) => void = (error) =>
    console.warn(
      `[@adonis-agora/resilience] could not add the ${extension.name} page to telescope:`,
      error,
    ),
): void {
  if (!container.hasBinding(TELESCOPE_EXTENSIONS_BINDING)) {
    container.bindValue(TELESCOPE_EXTENSIONS_BINDING, [extension]);
    return;
  }
  void container.make(TELESCOPE_EXTENSIONS_BINDING).then((list) => {
    if (!Array.isArray(list)) {
      onError(
        new Error(`'${TELESCOPE_EXTENSIONS_BINDING}' is bound to something that is not a list`),
      );
      return;
    }
    if (list.some((e) => (e as TelescopeExtension | undefined)?.name === extension.name)) return;
    list.push(extension);
  }, onError);
}
