import type { AcpConfigChoice, AcpConfigOption } from '../protocol/types';
import './ConfigPanel.css';

/**
 * Regroups flattened choices back into `<optgroup>`-shaped buckets,
 * preserving the agent's order (consecutive same-group choices share a
 * bucket; a null group renders as top-level options).
 */
export function groupChoices(choices: AcpConfigChoice[]): { group: string | null; items: AcpConfigChoice[] }[] {
  const buckets: { group: string | null; items: AcpConfigChoice[] }[] = [];
  for (const choice of choices) {
    const last = buckets[buckets.length - 1];
    if (last && last.group === choice.group) last.items.push(choice);
    else buckets.push({ group: choice.group, items: [choice] });
  }
  return buckets;
}

/**
 * The session settings card (agent-advertised config options): select
 * options render as a dropdown (grouped choices become optgroups), boolean
 * options as a toggle. Values shown are the document's — writes go through
 * `session/set_config_option` and the panel only moves when the confirmed
 * result comes back, so a failed write honestly leaves the old value.
 *
 * The card is mounted by the Composer at the composer-card level (floating
 * above the card like the slash-command panel); the Composer owns the open
 * state and renders the toolbar entry button.
 */
export function ConfigPanelCard({ options, disabled, onSetOption }: {
  options: AcpConfigOption[];
  disabled: boolean;
  onSetOption: (configId: string, value: string | boolean) => void;
}) {
  return (
    <div className="config-panel-card" role="group" aria-label="会话设置">
      <div className="config-panel-title">会话设置</div>
      {options.map((option) => (
        <div key={option.id} className="config-panel-row">
          <div className="config-panel-label">
            <span className="config-panel-name">{option.name}</span>
            {option.description && <span className="config-panel-desc">{option.description}</span>}
          </div>
          {option.type === 'select' ? (
            <select
              className="config-panel-select"
              value={option.currentValue}
              disabled={disabled}
              aria-label={option.name}
              onChange={(e) => onSetOption(option.id, e.target.value)}
            >
              {groupChoices(option.choices).map((bucket) =>
                bucket.group === null ? (
                  bucket.items.map((choice) => (
                    <option key={choice.value} value={choice.value}>{choice.name}</option>
                  ))
                ) : (
                  <optgroup key={bucket.group} label={bucket.group}>
                    {bucket.items.map((choice) => (
                      <option key={choice.value} value={choice.value}>{choice.name}</option>
                    ))}
                  </optgroup>
                ),
              )}
            </select>
          ) : (
            <button
              type="button"
              role="switch"
              aria-checked={option.currentValue}
              aria-label={option.name}
              disabled={disabled}
              className={`config-panel-toggle ${option.currentValue ? 'config-panel-toggle--on' : ''}`}
              onClick={() => onSetOption(option.id, !option.currentValue)}
            >
              <span className="config-panel-toggle-knob" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
