/** A ticket's status and the moves between them. Pure. */
export type Status = 'open' | 'assigned' | 'in_progress' | 'on_hold' | 'completed' | 'cancelled';
export type Move = 'assign' | 'start' | 'hold' | 'resume' | 'complete' | 'cancel' | 'reopen';

/** Not finished: details can change, people can be assigned, it can be cancelled. */
export const UNFINISHED: readonly Status[] = ['open', 'assigned', 'in_progress', 'on_hold'];

/**
 * open → assigned (first assignee) → in_progress (first ticket punch-in, or start) ⇄ on_hold → completed;
 * cancelled from any unfinished status; completed → in_progress when reopened. Returns the new status, or null when the
 * move is not allowed from this status.
 */
export function nextStatus(status: Status, move: Move): Status | null {
  switch (move) {
    case 'assign': return UNFINISHED.includes(status) ? (status === 'open' ? 'assigned' : status) : null;
    case 'start': return status === 'assigned' ? 'in_progress' : null;
    case 'hold': return status === 'in_progress' ? 'on_hold' : null;
    case 'resume': return status === 'on_hold' ? 'in_progress' : null;
    case 'complete': return status === 'in_progress' ? 'completed' : null;
    case 'cancel': return UNFINISHED.includes(status) ? 'cancelled' : null;
    case 'reopen': return status === 'completed' ? 'in_progress' : null;
  }
}

export const isFinished = (s: Status) => s === 'completed' || s === 'cancelled';
