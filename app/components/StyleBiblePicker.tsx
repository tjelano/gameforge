import type { Style } from '@/lib/database/schema';

interface StyleBiblePickerProps {
  styles: Style[];
  value: string;
  onChange: (styleId: string) => void;
}

export function StyleBiblePicker({ styles, value, onChange }: StyleBiblePickerProps) {
  return (
    <div className="field">
      <label htmlFor="style">Style Bible</label>
      <select id="style" value={value} onChange={e => onChange(e.target.value)}>
        {styles.map(style => (
          <option key={style.id} value={style.id}>
            {style.name}
          </option>
        ))}
      </select>
    </div>
  );
}
