// app/components/PresetForm.tsx
'use client';

import { useState } from 'react';

export interface PresetFormComponent {
  assetType: string;
  prompt: string;
}

export interface PresetFormValue {
  name: string;
  prompt: string;
  techStackTags: string; // comma-separated, as typed
  themePrompt: string;   // empty string means "no theme"
  components: PresetFormComponent[];
}

const EMPTY_VALUE: PresetFormValue = {
  name: '',
  prompt: '',
  techStackTags: '',
  themePrompt: '',
  components: [],
};

export function PresetForm({
  initial,
  onSubmit,
  submitLabel,
}: {
  initial?: Partial<PresetFormValue>;
  onSubmit: (value: PresetFormValue) => Promise<void>;
  submitLabel: string;
}) {
  const [value, setValue] = useState<PresetFormValue>({ ...EMPTY_VALUE, ...initial });
  const [newComponentType, setNewComponentType] = useState('');
  const [saving, setSaving] = useState(false);

  function addComponent() {
    const type = newComponentType.trim();
    if (!type) return;
    setValue(v => ({
      ...v,
      components: [...v.components, { assetType: type, prompt: `${v.prompt} ${type}`.trim() }],
    }));
    setNewComponentType('');
  }

  function updateComponentPrompt(index: number, prompt: string) {
    setValue(v => ({
      ...v,
      components: v.components.map((c, i) => (i === index ? { ...c, prompt } : c)),
    }));
  }

  function removeComponent(index: number) {
    setValue(v => ({ ...v, components: v.components.filter((_, i) => i !== index) }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !value.name.trim() || !value.prompt.trim()) return;
    setSaving(true);
    try {
      await onSubmit(value);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
      <div className="field">
        <label htmlFor="preset-name">Name</label>
        <input id="preset-name" value={value.name} onChange={e => setValue(v => ({ ...v, name: e.target.value }))} />
      </div>
      <div className="field">
        <label htmlFor="preset-prompt">Prompt</label>
        <textarea id="preset-prompt" rows={2} value={value.prompt} onChange={e => setValue(v => ({ ...v, prompt: e.target.value }))} />
      </div>
      <div className="field">
        <label htmlFor="preset-tags">Tech-stack tags (comma-separated)</label>
        <input id="preset-tags" value={value.techStackTags} onChange={e => setValue(v => ({ ...v, techStackTags: e.target.value }))} placeholder="Tailwind, React, SaaS" />
      </div>
      <div className="field">
        <label htmlFor="preset-theme-prompt">Theme prompt (optional)</label>
        <textarea id="preset-theme-prompt" rows={2} value={value.themePrompt} onChange={e => setValue(v => ({ ...v, themePrompt: e.target.value }))} />
      </div>

      <div>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Components</div>
        {value.components.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
            <span className="badge">{c.assetType}</span>
            <input
              value={c.prompt}
              onChange={e => updateComponentPrompt(i, e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn" onClick={() => removeComponent(i)}>Remove</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={newComponentType}
            onChange={e => setNewComponentType(e.target.value)}
            placeholder="nav bar"
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addComponent();
              }
            }}
          />
          <button type="button" className="btn" onClick={addComponent}>Add component</button>
        </div>
      </div>

      <button className="btn btn-primary" type="submit" disabled={saving || !value.name.trim() || !value.prompt.trim()}>
        {saving ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}
