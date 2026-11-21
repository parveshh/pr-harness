import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './workspace.css';
import { applyTypography } from './WorkspacePanels.js';
import { defaultTypography } from '../../shared/workspace.js';
import { Workspace } from './Workspace.js';
import './studio.css';
if (window.reviewer.integratedTitleBar)
  document.documentElement.classList.add('integrated-titlebar');
const root = document.getElementById('root');
if (!root) throw new Error('Missing workspace root.');
const app = createRoot(root);
void Promise.all([
  window.reviewer.getAppearance().catch(() => 'petrol' as const),
  window.reviewer.typography().catch(() => defaultTypography),
]).then(([theme, type]) => {
  document.documentElement.dataset.palette = theme;
  applyTypography(type);
  app.render(
    <StrictMode>
      <Workspace initialTheme={theme} initialType={type} />
    </StrictMode>,
  );
});
