/**
 * /cron/new — thin route wrapper around the shared CronEditor.
 * The component owns all the state, validation, and mutations.
 */
import { CronEditor } from "@/components/cron/CronEditor";

export default function CronNewScreen(): React.ReactElement {
  return <CronEditor mode="create" />;
}
