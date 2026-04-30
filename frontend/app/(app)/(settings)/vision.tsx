/**
 * Vision settings — Stage 4 redesign.
 *
 * Thin wrapper over <AuxPicker task="vision" />. The functional logic
 * (queries, mutations, redirect-on-save, *** sentinel for hidden keys)
 * lives in AuxPicker so the per-task aux screen can share it verbatim.
 */
import { AuxPicker } from "@/components/settings/AuxPicker";

export default function VisionSettingsScreen() {
  return <AuxPicker task="vision" title="Vision" />;
}
