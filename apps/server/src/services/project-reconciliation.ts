import { isValidProjectSlug } from "@zakura/shared";

export type ProjectWorkspaceRecord = { slug: string; hasWorkspace: boolean };

export type ProjectWorkspacePlan = {
  create: string[];
  enable: string[];
  disable: string[];
};

/**
 * Deterministically reconcile durable project metadata with workspace folders.
 * The planner is deliberately pure: callers can retry persistence without
 * rescanning the filesystem, and duplicate/invalid directory entries cannot
 * produce duplicate writes.
 */
export function planProjectWorkspaceReconciliation(
  rows: readonly ProjectWorkspaceRecord[],
  workspaceSlugs: readonly string[],
): ProjectWorkspacePlan {
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const disk = new Set(workspaceSlugs.filter(isValidProjectSlug));
  const create: string[] = [];
  const enable: string[] = [];
  const disable: string[] = [];

  for (const slug of [...disk].sort()) {
    const row = bySlug.get(slug);
    if (!row) create.push(slug);
    else if (!row.hasWorkspace) enable.push(slug);
  }
  for (const row of rows) {
    if (row.hasWorkspace && !disk.has(row.slug)) disable.push(row.slug);
  }
  disable.sort();
  return { create, enable, disable };
}

