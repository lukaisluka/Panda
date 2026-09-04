import { useState } from 'react';
import { CircleCheckBig, FormInput } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { Selector } from '@astryxdesign/core/Selector';
import { TextInput } from '@astryxdesign/core/TextInput';
import type {
  AcpElicitationField,
  ElicitationRequest,
  ElicitationResponse,
} from '../protocol/types';
import type { AttachedElicitation } from '../projector/messageStream';
import './ElicitationCard.css';

/**
 * The form-mode elicitation card: the agent asked the user for structured
 * input (`elicitation/create`, form mode). The wire schema restricts fields
 * to primitives, so the form is hand-rolled — one input per field variant,
 * required-gated submit, decline always available. Settled cards keep a
 * one-line terminal record in the flow.
 */
export function ElicitationCard({ elicitation, onResolve }: {
  elicitation: AttachedElicitation;
  onResolve: (id: string, response: ElicitationResponse) => void;
}) {
  if (elicitation.state === 'settled') return <SettledElicitationCard elicitation={elicitation} />;
  return <PendingElicitationCard request={elicitation.request} onResolve={onResolve} />;
}

function PendingElicitationCard({ request, onResolve }: {
  request: ElicitationRequest;
  onResolve: (id: string, response: ElicitationResponse) => void;
}) {
  const [values, setValues] = useState<Record<string, string | number | boolean | string[]>>({});
  const set = (key: string, value: string | number | boolean | string[]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const numberError = request.fields.find((field) => {
    if (field.type !== 'number' && field.type !== 'integer') return false;
    const raw = values[field.key];
    if (raw === undefined || raw === '') return false; // absence is required's business
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isNaN(parsed)) return true;
    return field.type === 'integer' && !Number.isInteger(parsed);
  });

  // Boolean is exempt: a checkbox's either state IS an answer (JSON Schema
  // has no unanswered-vs-false distinction — that's what defaults are for),
  // so forcing a check would outlaw the legitimate false answer. Unsupported
  // fields can never satisfy a requirement — but they can't fail one either.
  const missingRequired = request.fields.find((field) => {
    if (field.type === 'unsupported' || field.type === 'boolean' || !field.required) return false;
    const value = values[field.key] ?? defaultsFor(field);
    if (Array.isArray(value)) return value.length === 0;
    return value === undefined || value === '';
  });

  const canSubmit = !missingRequired && !numberError;

  const submit = () => {
    if (!canSubmit) return;
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const field of request.fields) {
      const fallback = defaultsFor(field);
      const value = values[field.key] ?? fallback;
      if (value === undefined || value === '') continue; // optional & untouched
      if (field.type === 'number' || field.type === 'integer') {
        // Text inputs carry strings; the wire answer must carry numbers.
        const parsed = typeof value === 'number' ? value : Number(value);
        if (Number.isNaN(parsed)) continue; // numberError already gates submit
        content[field.key] = parsed;
      } else if (Array.isArray(value) && value.length === 0) {
        continue; // optional multiselect with nothing picked
      } else {
        content[field.key] = value;
      }
    }
    onResolve(request.id, { outcome: 'accepted', content });
  };

  return (
    <div className="elicit-card">
      <div className="elicit-head">
        <FormInput size={14} />
        Agent 请求信息
      </div>
      {request.title && <p className="elicit-title">{request.title}</p>}
      {request.description && <p className="elicit-desc">{request.description}</p>}
      <div className="elicit-fields">
        {request.fields.map((field) => (
          <ElicitationField key={field.key} field={field} value={values[field.key] ?? defaultsFor(field)} onChange={(value) => set(field.key, value)} />
        ))}
      </div>
      <div className="elicit-actions">
        <Button size="sm" variant="secondary" label="拒绝" clickAction={() => onResolve(request.id, { outcome: 'declined' })} />
        <Button size="sm" variant="primary" label="提交" isDisabled={!canSubmit} clickAction={submit} />
      </div>
    </div>
  );
}

/** The schema default (or a sensible empty), so untouched fields behave. */
function defaultsFor(field: AcpElicitationField): string | number | boolean | string[] | undefined {
  switch (field.type) {
    case 'string':
      // A Selector has no empty option: with no default, the first choice
      // stands in as the initial value.
      return field.default ?? (field.options && field.options.length > 0 ? field.options[0]?.value : undefined);
    case 'number':
    case 'integer':
      return field.default;
    case 'boolean':
      return field.default;
    case 'multiselect':
      return field.default ?? [];
    case 'unsupported':
      return undefined;
  }
}

function ElicitationField({ field, value, onChange }: {
  field: AcpElicitationField;
  value: string | number | boolean | string[] | undefined;
  onChange: (value: string | number | boolean | string[]) => void;
}) {
  const label = (
    <span className="elicit-label">
      {field.title}
      {field.required && <span className="elicit-required" title="必填">*</span>}
    </span>
  );

  if (field.type === 'unsupported') {
    return (
      <div className="elicit-field">
        {label}
        <p className="elicit-unsupported">暂不支持的字段类型({field.propertyType}),此项不可填写</p>
      </div>
    );
  }

  if (field.type === 'boolean') {
    return (
      <label className="elicit-field elicit-field--check">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  }

  if (field.type === 'multiselect') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div className="elicit-field">
        {label}
        <div className="elicit-multiselect">
          {field.options.map((option) => (
            <label key={option.value} className="elicit-field--check elicit-choice">
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, option.value]
                      : selected.filter((entry) => entry !== option.value),
                  )
                }
              />
              {option.label}
            </label>
          ))}
        </div>
      </div>
    );
  }

  if (field.type === 'string' && field.options) {
    return (
      <div className="elicit-field">
        {label}
        <Selector
          label={field.title}
          isLabelHidden
          value={typeof value === 'string' ? value : ''}
          onChange={(next) => onChange(next)}
          options={field.options.map((option) => ({ value: option.value, label: option.label }))}
        />
      </div>
    );
  }

  if (field.type === 'number' || field.type === 'integer') {
    const raw = value === undefined || value === '' ? '' : String(value);
    return (
      <div className="elicit-field">
        {label}
        <TextInput
          className="elicit-input"
          label={field.title}
          isLabelHidden
          width="100%"
          value={raw}
          onChange={(next) => onChange(next)}
          placeholder={field.type === 'integer' ? '整数' : '数字'}
        />
      </div>
    );
  }

  // Free text.
  return (
    <div className="elicit-field">
      {label}
      <TextInput
        className="elicit-input"
        label={field.title}
        isLabelHidden
        width="100%"
        value={typeof value === 'string' ? value : ''}
        onChange={(next) => onChange(next)}
      />
    </div>
  );
}

function SettledElicitationCard({ elicitation }: { elicitation: Extract<AttachedElicitation, { state: 'settled' }> }) {
  const summary =
    elicitation.response.outcome === 'accepted'
      ? `已提交(${Object.keys(elicitation.response.content).length} 项)`
      : elicitation.response.outcome === 'declined'
        ? '已拒绝'
        : '已取消(非用户决定)';
  return (
    <div className="elicit-card elicit-card--settled">
      <div className="elicit-head elicit-head--settled">
        <CircleCheckBig size={14} />
        {elicitation.request.title ?? 'Agent 请求信息'} · {summary}
      </div>
    </div>
  );
}
