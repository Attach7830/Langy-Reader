import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-600.css';
import './styles.css';
import { authenticationGate } from './auth.js';
import { accountPanel } from './ui-accounts.js';

const session = await authenticationGate();
if (session.enabled) accountPanel(session);
await import('./main.js');
