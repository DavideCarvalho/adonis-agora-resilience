// agora-doctor command v1 — keep identical across libs
import { BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { type DoctorApp, exitCodeOf, renderHuman, runDoctor } from '../src/doctor/agora_doctor.js';

/**
 * `node ace agora:doctor` — health checks of every installed `@adonis-agora` lib.
 * Flags: `--lib=a,b`, `--only=<id>`, `--deep`, `--json`, `--strict`, `--verbose`, `--no-boot`.
 * Exit code: 0 no error, 1 an error (or a warning with `--strict`), 2 the doctor could not run.
 */
export default class AgoraDoctor extends BaseCommand {
  static override commandName = 'agora:doctor';
  static override description = 'Check the configuration of every installed @adonis-agora lib';
  static override options: CommandOptions = { startApp: false };

  /** Set by a `<lib>:doctor` alias. */
  protected presetLibs?: string[];

  declare lib?: string;
  declare only?: string;
  declare deep?: boolean;
  declare json?: boolean;
  declare strict?: boolean;
  declare verbose?: boolean;
  declare boot: boolean;

  static {
    AgoraDoctor.defineFlag('lib', {
      type: 'string',
      description: 'Only these libs (comma separated)',
    });
    AgoraDoctor.defineFlag('only', { type: 'string', description: 'Only the check with this id' });
    AgoraDoctor.defineFlag('deep', {
      type: 'boolean',
      description: 'Also run checks that reach the database, Redis or the network',
    });
    AgoraDoctor.defineFlag('json', { type: 'boolean', description: 'Print one JSON object' });
    AgoraDoctor.defineFlag('strict', { type: 'boolean', description: 'Fail on warnings too' });
    AgoraDoctor.defineFlag('verbose', {
      type: 'boolean',
      description: 'Show skipped checks and stacks',
    });
    AgoraDoctor.defineFlag('boot', {
      type: 'boolean',
      default: true,
      showNegatedVariantInHelp: true,
      description:
        'Boot the app (--no-boot: peer and version checks only, for an app that does not boot)',
    });
  }

  override async run(): Promise<void> {
    const noBoot = this.boot === false;
    if (!noBoot && !this.app.isBooted) {
      try {
        await this.app.boot();
        await this.app.start(() => {});
      } catch (error) {
        this.logger.error(
          `the app does not boot, so the doctor cannot run its checks: ${error instanceof Error ? error.message : String(error)}. Run with --no-boot for the peer and version checks.`,
        );
        this.exitCode = 2;
        return;
      }
    }
    const libs =
      this.presetLibs ??
      (this.lib
        ? this.lib
            .split(',')
            .map((l) => l.trim())
            .filter(Boolean)
        : undefined);
    try {
      const report = await runDoctor(
        this.app as unknown as DoctorApp,
        {
          ...(libs ? { libs } : {}),
          ...(this.only ? { only: this.only } : {}),
          deep: this.deep === true,
          noBoot,
        },
        this.verbose === true,
      );
      if (this.json) {
        this.logger.log(JSON.stringify(report));
      } else {
        const tty = process.stdout.isTTY === true && !process.env.NO_COLOR;
        const colors = this.colors;
        this.logger.log(
          renderHuman(report, {
            symbols: tty,
            verbose: this.verbose === true,
            ...(tty
              ? {
                  colors: {
                    green: (t: string) => colors.green(t),
                    yellow: (t: string) => colors.yellow(t),
                    red: (t: string) => colors.red(t),
                    dim: (t: string) => colors.dim(t),
                  },
                }
              : {}),
          }),
        );
      }
      this.exitCode = exitCodeOf(report, this.strict === true);
    } catch (error) {
      // A DoctorUsageError (unknown --only id, unknown registry version) or a runner failure.
      this.logger.error(error instanceof Error ? error.message : String(error));
      this.exitCode = 2;
    }
  }
}
