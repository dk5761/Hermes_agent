/**
 * Public surface of the `@/search` module — Phase 4 imports from here.
 */
export { useSearch, type UseSearchResult } from "./useSearch";
export { QuickSwitcher, renderSnippet } from "./QuickSwitcher";
export type { QuickSwitcherProps } from "./QuickSwitcher";
export { useQuickSwitcher } from "@/state/quick-switcher";
export type { QuickSwitcherState } from "@/state/quick-switcher";
export type { SearchResult } from "@/api/search";
