import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './fonts.css';
import './workspace.css';
import { applyTypography } from './WorkspacePanels.js';
import { defaultTypography } from '../../shared/workspace.js';
import { Workspace } from './Workspace.js';
import './studio.css';
import './review-layout.css';
if (window.reviewer.integratedTitleBar)
  document.documentElement.classList.add('integrated-titlebar');
const root = document.getElementById('root');
if (!root) throw new Error('Missing workspace root.');
const app = createRoot(root);
void Promise.all([
  window.reviewer.getAppearance().catch(() => 'ink' as const),
  window.reviewer.typography().catch(() => defaultTypography),
  window.reviewer.getAccent().catch(() => 'green' as const),
  window.reviewer.getSidebarVibrancy().catch(() => false),
  // Single-key shortcuts default to on when the setting cannot be read.
  window.reviewer.getSingleKeyShortcuts().catch(() => true),
]).then(([theme, type, accent, vibrancy, shortcuts]) => {
  document.documentElement.classList.toggle('sidebar-vibrancy', vibrancy);
  document.documentElement.dataset.palette = theme;
  document.documentElement.dataset.accent = accent;
  applyTypography(type);
  app.render(
    <StrictMode>
      <Workspace
        initialVibrancy={vibrancy}
        initialShortcuts={shortcuts}
        initialTheme={theme}
        initialType={type}
        initialAccent={accent}
      />
    </StrictMode>,
  );
});
