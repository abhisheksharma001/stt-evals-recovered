// Cross-component navigation guard (bug-register B-14): the Review page
// holds unsaved gold edits, but a sidebar click unmounts it without running
// its own confirm — beforeunload only covers tab close. The active page
// registers a guard while it has unsaved work; the sidebar consults it
// before letting wouter navigate.
type NavGuard = () => boolean;

let guard: NavGuard | null = null;

export function setNavGuard(fn: NavGuard | null): void {
  guard = fn;
}

/** Returns true when navigation may proceed. */
export function runNavGuard(): boolean {
  return guard ? guard() : true;
}
