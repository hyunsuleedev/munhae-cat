export type ProjectTransitionKind = "create" | "open" | "seed" | "close";

export type ProjectTransitionHooks = {
  before?: (kind: ProjectTransitionKind) => boolean | Promise<boolean>;
  committed?: (kind: ProjectTransitionKind) => void;
};

export type ProjectTransitionResult<T> =
  | { started: false }
  | { started: true; result: T };

/**
 * Keep the renderer's unsaved-edit decision ahead of every project mutation.
 * A successful main-process mutation commits the leave decision; cancellations
 * and errors leave the renderer's dirty state untouched.
 */
export async function runProjectTransition<T>(
  kind: ProjectTransitionKind,
  hooks: ProjectTransitionHooks,
  action: () => Promise<T>,
  didCommit: (result: T) => boolean,
): Promise<ProjectTransitionResult<T>> {
  if (hooks.before && !(await hooks.before(kind))) return { started: false };

  const result = await action();
  if (didCommit(result)) hooks.committed?.(kind);
  return { started: true, result };
}
