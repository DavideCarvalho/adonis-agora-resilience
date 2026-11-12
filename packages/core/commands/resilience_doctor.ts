import AgoraDoctor from './agora_doctor.js';

/** `node ace resilience:doctor` — `agora:doctor` for `@adonis-agora/resilience` only. */
export default class ResilienceDoctor extends AgoraDoctor {
  static override commandName = 'resilience:doctor';
  static override description = 'Check the @adonis-agora/resilience configuration';
  protected override presetLibs = ['resilience'];
}
