/**
 * One partition the partition-maintenance job would detach and drop: its
 * name and the instants its range starts (null for the legacy partition,
 * FROM (MINVALUE)) and ends.
 */
interface PartitionToDrop {
  name: string;
  from: Date | null;
  to: Date;
}

/**
 * What a registered table's gate answers before the job detaches one of
 * its partitions past the retention (src/shared/database/partitions.ts,
 * dropGate): true once whatever must outlive the rows is done and nothing
 * in it is still in flight. False keeps the partition attached and
 * readable for the next night. A gate swallows its own failures (it logs
 * them and says false): the partitions ahead of every other table must
 * still be made.
 */
interface PartitionDropGate {
  mayDrop(parent: string, partition: PartitionToDrop): Promise<boolean>;
}

export type { PartitionDropGate, PartitionToDrop };
