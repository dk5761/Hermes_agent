export interface BuildObjectKeyInput {
  userId: string;
  sha256?: string | undefined;
  fallbackId?: string | undefined;
  now?: Date | undefined;
}

export function buildObjectKey(input: BuildObjectKeyInput): string {
  const now = input.now ?? new Date();
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const tail = input.sha256 ?? input.fallbackId;
  if (!tail) {
    throw new Error("buildObjectKey requires sha256 or fallbackId");
  }
  return `${input.userId}/${yyyy}/${mm}/${tail}`;
}
