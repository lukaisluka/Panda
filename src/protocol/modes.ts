import type { AcpConfigOption, AcpSessionModeState } from './types';

/**
 * protocol/v1 session-config-options: "Clients that support config options
 * SHOULD use configOptions exclusively and ignore modes." When the agent
 * models its mode selector as a config option (a select with the reserved
 * `mode` category), the mode picker derives its state from that entry so
 * both UI entry points stay in sync — writes then go through
 * set_config_option, whose full-list response refreshes everything at once.
 * Returns null when no mode-like option exists: agents that only speak the
 * older session-modes channel keep the doc.modes flow untouched.
 */
export function modeStateFromConfigOptions(options: AcpConfigOption[] | null): AcpSessionModeState | null {
  if (options === null) return null;
  const modeOption = options.find(
    (option): option is Extract<AcpConfigOption, { type: 'select' }> =>
      option.type === 'select' && option.category === 'mode',
  );
  if (!modeOption) return null;
  return {
    currentModeId: modeOption.currentValue,
    availableModes: modeOption.choices.map((choice) => ({
      id: choice.value,
      name: choice.name,
      description: choice.description ?? undefined,
    })),
  };
}
