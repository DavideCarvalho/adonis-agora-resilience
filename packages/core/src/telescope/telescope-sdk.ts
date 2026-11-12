/**
 * A local, structural mirror of the `@adonis-agora/telescope` extension contract. Resilience never
 * imports telescope: the extension object built here satisfies telescope's `TelescopeExtension`
 * structurally when both are installed. Keep in step with telescope's `extension/types.ts`.
 */

/** The slice of a telescope entry the data providers read. */
export interface TelescopeEntryLike {
  id?: string;
  content?: unknown;
  createdAt?: Date | string;
}

/** The slice of telescope's `EntryQuery` the data providers use. */
export interface TelescopeEntryQuery {
  type?: string;
  tag?: string;
  after?: Date;
  before?: Date;
  page?: number;
  size?: number;
}

/** The slice of the telescope store the data providers read. */
export interface TelescopeStoreLike {
  list(query?: TelescopeEntryQuery): Promise<TelescopeEntryLike[]>;
}

/** The slice of the AdonisJS container an extension uses to resolve host services. */
export interface ContainerLike {
  make<T>(token: unknown): Promise<T>;
}

/** Read-only context handed to every extension hook. */
export interface ExtensionContext {
  readonly store: TelescopeStoreLike;
  readonly container: ContainerLike;
  readonly config: unknown;
}

export interface ExtensionEntryType {
  id: string;
  label: string;
  dot: string;
}

export interface PanelThresholds {
  warn: number;
  bad: number;
  direction: 'up-bad' | 'down-bad';
}

export interface DashboardSection {
  title?: string;
  cols?: 2 | 3 | 4;
  panels: Panel[];
}

export interface DashboardSpec {
  id: string;
  label: string;
  navGroup?: string;
  panels: Panel[];
  sections?: DashboardSection[];
}

export interface DataBinding {
  provider: string;
  query?: Record<string, unknown>;
}

export interface LinkSpec {
  href: string;
  external?: boolean;
}

/**
 * A row action on a table column: the UI shows a button that, after the confirmation of the
 * extension action `name`, posts `input` (row `{key}` placeholders filled in) to that action.
 */
export interface ColumnAction {
  /** The extension action to run (see {@link ExtensionAction.name}). */
  name: string;
  /** Button label. Defaults to the action's label. */
  label?: string;
  /**
   * Input sent to the action, as templates: `{field}` is replaced by the row's `field` value
   * (`{ key: '{key}' }` sends the row's `key`). Same placeholder syntax as {@link LinkSpec.href}.
   */
  input: Record<string, string>;
  /** Show the button only on rows whose field holds one of these values. */
  showWhen?: Record<string, string[]>;
}

export interface Column {
  key: string;
  label: string;
  link?: LinkSpec;
  action?: ColumnAction;
}

export type Panel =
  | {
      kind: 'stat';
      title: string;
      data: DataBinding;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      accent?: string;
      spark?: boolean;
      thresholds?: PanelThresholds;
    }
  | {
      kind: 'timeseries';
      title: string;
      data: DataBinding;
      series: string[];
      style?: 'area' | 'stacked';
    }
  | { kind: 'topN'; title: string; data: DataBinding; limit?: number }
  | { kind: 'table'; title: string; data: DataBinding; columns: Column[]; paged?: boolean }
  | {
      kind: 'distribution';
      title: string;
      data: DataBinding;
      markers?: Array<'p50' | 'p95' | 'p99'>;
      format?: 'duration' | 'number';
    }
  | {
      kind: 'gauge';
      title: string;
      data: DataBinding;
      min?: number;
      max?: number;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      thresholds?: PanelThresholds;
    }
  | { kind: 'breakdown'; title: string; data: DataBinding; style?: 'donut' | 'bar' };

export interface DataProvider {
  name: string;
  resolve(query: Record<string, unknown> | undefined, ctx: ExtensionContext): Promise<unknown>;
}

/** What an extension action receives besides its input. */
export interface ExtensionActionContext extends ExtensionContext {
  /** Who is acting, as the telescope console identified them (`user:42`, `token:3f9a…`). */
  readonly actor?: string;
  /** The HTTP context of the request, when there is one. */
  readonly http?: unknown;
}

/**
 * A write action an extension offers from its pages. Telescope runs it behind its console
 * `authorize`, after the user confirmed `confirm`.
 */
export interface ExtensionAction {
  /** Unique, namespaced by the extension: `resilience.reset-circuit`. */
  name: string;
  label: string;
  /** Confirmation text, `{field}` placeholders filled from the input. */
  confirm?: string;
  destructive?: boolean;
  run(input: Record<string, unknown>, ctx: ExtensionActionContext): Promise<unknown>;
}

export interface TelescopeExtension {
  name: string;
  entryTypes?(ctx: ExtensionContext): ExtensionEntryType[];
  dashboards?(ctx: ExtensionContext): DashboardSpec[];
  dataProviders?(ctx: ExtensionContext): DataProvider[];
  /** Write actions run from the extension's pages (see {@link ColumnAction}). */
  actions?(ctx: ExtensionContext): ExtensionAction[];
}

/** The container key apps' libs push their telescope extensions into. */
export const TELESCOPE_EXTENSIONS_BINDING = 'agora.telescope.extensions';
