import { useState } from 'react';
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { Bot, ChevronsUpDown } from 'lucide-react';
import {
  agentId,
  agentNames,
  selection as selectionSchema,
  type AgentCatalog,
  type AgentId,
  type Selection,
} from '../../../shared/assistant.js';

type Props = {
  catalog: AgentCatalog | null;
  error: string;
  onChange: (value: Selection) => void;
  onChooseExecutable: (agent: AgentId) => void;
  onRetry: () => void;
};

// The harness and model chosen here answer every question in the app.
export function AgentPicker({ catalog, onRetry, ...actions }: Props) {
  if (!catalog)
    return actions.error ? (
      <Button className="agent-trigger" onPress={onRetry}>
        <Bot size={15} /> <span>Retry loading harnesses</span>
      </Button>
    ) : (
      <Button className="agent-trigger" isDisabled aria-label="Harness and model">
        <Bot size={15} /> <span>Harness</span>
      </Button>
    );
  const { selection } = catalog;
  const label = agentNames[selection.agent] + ' · ' + (selection.model || 'default model');
  return (
    <DialogTrigger>
      <Button className="agent-trigger" aria-label={'Harness and model: ' + label}>
        <Bot size={15} /> <span title={label}>{label}</span> <ChevronsUpDown size={13} />
      </Button>
      <Popover className="agent-menu" placement="bottom end" offset={6}>
        <Dialog className="agent-form" aria-label="Harness and model">
          <AgentForm catalog={catalog} {...actions} />
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function AgentForm({
  catalog,
  error,
  onChange,
  onChooseExecutable,
}: Omit<Props, 'onRetry'> & { catalog: AgentCatalog }) {
  const { agents, selection } = catalog;
  const [model, setModel] = useState(selection.model);
  const [invalid, setInvalid] = useState('');
  const installed = agents.find((a) => a.id === selection.agent);
  function choose(next: Selection) {
    const checked = selectionSchema.safeParse(next);
    setInvalid(checked.success ? '' : (checked.error.issues[0]?.message ?? 'Check the model.'));
    if (checked.success) onChange(checked.data);
  }
  return (
    <>
      <div className="appearance-label">Used for every review</div>
      <label>
        Harness
        <select
          aria-label="Harness"
          value={selection.agent}
          onChange={(e) => {
            // Models belong to a harness and provider, so switching either clears the field.
            setModel('');
            choose({ agent: agentId.parse(e.target.value), model: '', provider: 'default' });
          }}
        >
          {agentId.options.map((id) => (
            <option key={id} value={id}>
              {agentNames[id]}
              {agents.some((a) => a.id === id) ? '' : ' (not found)'}
            </option>
          ))}
        </select>
      </label>
      {selection.agent === 'codex' && (
        <label>
          Inference provider
          <select
            aria-label="Inference provider"
            value={selection.provider}
            onChange={(e) => {
              setModel('');
              choose({
                agent: 'codex',
                model: '',
                provider: selectionSchema.shape.provider.parse(e.target.value),
              });
            }}
          >
            <option value="default">Codex default</option>
            <option value="ollama">Local · Ollama</option>
            <option value="lmstudio">Local · LM Studio</option>
          </select>
        </label>
      )}
      <label>
        Model
        <input
          aria-label="Model"
          list="agent-models"
          value={model}
          placeholder="Agent default"
          spellCheck={false}
          onChange={(e) => {
            setModel(e.target.value);
            choose({ ...selection, model: e.target.value });
          }}
        />
        <datalist id="agent-models">
          {(selection.provider === 'default' ? (installed?.models ?? []) : []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <p>
        {installed?.version ?? 'Executable not found'} ·{' '}
        {selection.provider === 'default' ? 'Uses agent provider' : 'Local inference'}
      </p>
      <button type="button" onClick={() => onChooseExecutable(selection.agent)}>
        Choose executable…
      </button>
      {(invalid || error) && <p role="alert">{invalid || error}</p>}
    </>
  );
}
