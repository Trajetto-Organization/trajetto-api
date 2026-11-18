import type { Prisma } from "@prisma/client";

type Client = Pick<Prisma.TransactionClient, "$queryRawUnsafe">;

interface NamedNode {
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: NamedNode[];
}

/**
 * Every partition and partition index of this database, by name, mapped to
 * its parent's name.
 */
async function parentNames(client: Client): Promise<Map<string, string>> {
  const rows = await client.$queryRawUnsafe<
    Array<{ child: string; parent: string }>
  >(
    `SELECT c.relname::text AS child, p.relname::text AS parent
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     WHERE c.relispartition`,
  );

  return new Map(rows.map((row) => [row.child, row.parent]));
}

/**
 * An EXPLAIN plan with each partition and partition index named as its
 * parent.
 *
 * The four queues are partitioned by day since the swap of plano-escala
 * F5-09, which every E2E database has run: a plan reads
 * notification_delivery_legacy through notification_delivery_pkey_legacy,
 * and each day through an index Postgres named for it. What a plan test
 * asks is still "which table, through which index": the parent's index
 * every partition's is attached to.
 */
async function withParentNames<Node extends NamedNode>(
  client: Client,
  plan: Node,
): Promise<Node> {
  const parents = await parentNames(client);
  const rename = (node: NamedNode): NamedNode => ({
    ...node,
    ...(node["Relation Name"] && {
      "Relation Name":
        parents.get(node["Relation Name"]) ?? node["Relation Name"],
    }),
    ...(node["Index Name"] && {
      "Index Name": parents.get(node["Index Name"]) ?? node["Index Name"],
    }),
    ...(node.Plans && { Plans: node.Plans.map(rename) }),
  });

  return rename(plan) as Node;
}

export { parentNames, withParentNames };
