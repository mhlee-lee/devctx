import type { Provider, ProviderId } from '../types.ts';
import { claudeProvider } from './claude.ts';
import { codexProvider } from './codex.ts';
import { copilotProvider } from './copilot.ts';
import { cursorProvider } from './cursor.ts';
import { fakeProvider } from './fake.ts';
import { kiroProvider } from './kiro.ts';

export const PROVIDERS: Record<ProviderId, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
  copilot: copilotProvider,
  cursor: cursorProvider,
  kiro: kiroProvider,
  fake: fakeProvider,
};

export function getProvider(id: ProviderId): Provider {
  return PROVIDERS[id];
}
