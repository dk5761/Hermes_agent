/**
 * /cron/[jobId]/edit — thin route wrapper around the shared CronEditor.
 * Hydrates the form from the existing job's detail query.
 */
import { useLocalSearchParams } from "expo-router";
import { CronEditor } from "@/components/cron/CronEditor";

export default function CronEditScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ jobId: string }>();
  return <CronEditor mode="edit" jobId={params.jobId ?? ""} />;
}
