import { Badge, IconCircle, ListRow } from "@/components/ui";
import { countCleaned, type Assignment } from "@/data/assignments";
import type { Crew } from "@/data/crews";

type Props = { crew: Crew; assignment?: Assignment; divider?: boolean };

// A crew in Dispatch: whether it's on duty and how far along its route is
export function CrewRow({ crew, assignment, divider }: Props) {
  const cleaned = assignment ? countCleaned(assignment) : 0;
  const total = assignment?.stops.length ?? 0;

  const badge = !assignment
    ? <Badge label="No route" />
    : cleaned === total
      ? <Badge label="Route done" tone="success" />
      : <Badge label={`${cleaned} of ${total} cleaned`} tone="info" />;

  return (
    <ListRow
      divider={divider}
      leading={<IconCircle icon="truck" faint={!crew.onDuty} />}
      title={crew.name}
      subtitle={crew.onDuty ? "On duty" : "Off duty"}
      trailing={badge}
    />
  );
}
