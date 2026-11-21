import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { Check, ChevronsUpDown, Palette } from 'lucide-react';
import { appearance, appearanceNames, type Appearance } from '../../../shared/appearance.js';

export function AppearancePicker({
  theme,
  onChange,
  compact,
}: {
  theme: Appearance;
  onChange: (value: Appearance) => void;
  compact: boolean;
}) {
  return (
    <MenuTrigger>
      <Button className="appearance-trigger" aria-label={'Appearance: ' + appearanceNames[theme]}>
        {compact ? <Palette size={16} /> : <span className="palette-swatch" data-palette={theme} />}
        {!compact && <span>{appearanceNames[theme]}</span>}
        {!compact && <ChevronsUpDown size={13} />}
      </Button>
      <Popover
        className="appearance-menu"
        placement={compact ? 'bottom end' : 'top start'}
        offset={6}
      >
        <div className="appearance-label">Appearance</div>
        <Menu
          aria-label="Appearance"
          selectionMode="single"
          selectedKeys={[theme]}
          onAction={(key) => onChange(appearance.parse(key))}
        >
          {appearance.options.map((value) => (
            <MenuItem
              key={value}
              id={value}
              textValue={appearanceNames[value]}
              className="appearance-option"
            >
              <span className="palette-swatch" data-palette={value} />
              <span>{appearanceNames[value]}</span>
              {theme === value && <Check size={14} />}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
