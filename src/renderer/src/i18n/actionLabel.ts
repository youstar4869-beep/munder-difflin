import type { TFunction } from 'i18next';

/**
 * Display-only translation of an agent's `action` string.
 *
 * `agent.action` is state, not copy: other code compares it against these exact
 * English phrases, so the stored value must stay English. This maps the fixed
 * phrases the app itself writes to a translated label at render time, and
 * translates the verb of `using <Tool>` while leaving the tool name alone.
 * Anything else (a file name, a prompt excerpt) is returned untouched.
 */
const FIXED: Record<string, string> = {
  'awaiting': 'awaiting',
  'running the floor': 'runningTheFloor',
  'compacting context': 'compactingContext',
  'resumed': 'resumed',
  'thinking': 'thinking',
  'idle': 'idle',
  'reading inbox': 'readingInbox',
  'starting up': 'startingUp',
  'revived after sleep': 'revivedAfterSleep',
  'waiting on you': 'waitingOnYou',
  'waiting on god': 'waitingOnGod',
  'heading back to desk': 'headingBackToDesk',
  'reconnecting…': 'reconnecting',
  'archived': 'archived'
};

export function actionLabel(action: string, t: TFunction): string {
  const key = FIXED[action];
  if (key) return t(`agentAction.${key}`, action);
  const using = /^using (.+)$/.exec(action);
  if (using) return t('agentAction.using', action, { tool: using[1] });
  return action;
}
