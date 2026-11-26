import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-600.css';
import './styles.css';
import { authenticationGate } from './auth.js';
import { accountPanel } from './ui-accounts.js';
import { startup } from './startup.js';

startup.start('Checking your sign-in…');
try {
  const session = await authenticationGate();
  startup.start('Loading the reader…');
  if (session.enabled) accountPanel(session);
  await import('./main.js');
} catch (error) { startup.fail(error); }
