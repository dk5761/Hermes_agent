import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { getAttachment } from "../api/uploads";
import type { AttachmentDTO } from "../api/types";

const STALE_MS = 5 * 60_000;
const EMPTY_IDS: readonly string[] = [];

// Resolve a list of attachment IDs to their DTOs, with disk-cache via TanStack.
// Returns only the DTOs that have already loaded — others appear as they
// resolve. Callers should not assume the array length matches the input list.
export function useAttachmentsByIds(
  ids: ReadonlyArray<string> | undefined,
): readonly AttachmentDTO[] {
  const list: ReadonlyArray<string> = ids ?? EMPTY_IDS;
  const queries = useQueries({
    queries: list.map((id) => ({
      queryKey: ["attachment", id] as const,
      queryFn: (): Promise<AttachmentDTO> => getAttachment(id),
      staleTime: STALE_MS,
    })),
  });
  return useMemo(
    () =>
      queries
        .map((q) => q.data)
        .filter((d): d is AttachmentDTO => !!d),
    [queries],
  );
}
