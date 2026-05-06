// Auto-suffix helper for branch titles. When the user invokes /branch without
// supplying a title, we derive one from the parent: `${parent.title} (branch N)`
// where N is the smallest positive integer (capped at 99) that doesn't collide
// with this user's existing branches of the same parent.
//
// The collision set is intentionally scoped to ONE user × ONE parent at the
// call site — we don't want global uniqueness (different conversations can
// reuse "Branch (branch 1)") nor cross-user leakage (privacy + correctness).
const MAX_BRANCH_INDEX = 99;

export function nextBranchTitle(
  parentTitle: string | null,
  existingTitles: ReadonlySet<string>,
): string {
  const base = parentTitle ?? "Branch";
  for (let i = 1; i <= MAX_BRANCH_INDEX; i++) {
    const candidate = `${base} (branch ${i})`;
    if (!existingTitles.has(candidate)) return candidate;
  }
  // All 99 slots taken — fall back to the last index. Astronomically unlikely.
  return `${base} (branch ${MAX_BRANCH_INDEX})`;
}
