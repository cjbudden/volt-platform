/** Sub-account subtree resolution. Needs DATABASE_URL -> fresh Postgres (0001 applied). */
import { query, pool } from '../src/db';
import { accountSubtree, isInSubtree } from '../src/services/tenancy';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)));

(async () => {
  // parent P -> children C1, C2 ; C1 -> grandchild G
  // Ids are namespaced to THIS suite (…7e11…). They used to start at
  // 0000…00a1, which the orchestrator check also claims as its account: run
  // both against one database and whichever went second died on a key
  // collision, or worse, deleted the other's fixture out from under it.
  const P = '00000000-0000-0000-0000-00007e110001';
  const C1 = '00000000-0000-0000-0000-00007e110c11';
  const C2 = '00000000-0000-0000-0000-00007e110c22';
  const G = '00000000-0000-0000-0000-00007e1100e1';
  const OTHER = '00000000-0000-0000-0000-00007e1100d0';
  // The fixture must be re-runnable. Inserting these ids bare crashed on the
  // SECOND run against the same database with a primary-key violation, which
  // reads like a product fault and is not one: a check that only passes on a
  // virgin Postgres is a check nobody runs twice. Grandchildren are removed
  // before their parents so no foreign key blocks the delete.
  await query(`DELETE FROM accounts WHERE parent_account_id = ANY($1)`, [[C1, C2]]);
  await query(`DELETE FROM accounts WHERE parent_account_id = $1`, [P]);
  await query(`DELETE FROM accounts WHERE id = ANY($1)`, [[G, C1, C2, P, OTHER]]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'Parent'),($2,'Other')`, [P, OTHER]);
  await query(`INSERT INTO accounts(id,name,parent_account_id) VALUES ($1,'C1',$3),($2,'C2',$3)`, [C1, C2, P]);
  await query(`INSERT INTO accounts(id,name,parent_account_id) VALUES ($1,'G',$2)`, [G, C1]);

  const sub = (await accountSubtree(P)).sort();
  ok(sub.length === 4, `parent subtree has 4 accounts (self+2 children+grandchild) — got ${sub.length}`);
  ok(sub.includes(C1) && sub.includes(C2) && sub.includes(G) && sub.includes(P), 'subtree includes self, children, grandchild');
  ok(!sub.includes(OTHER), 'subtree excludes an unrelated account');

  ok(await isInSubtree(P, G), 'grandchild is in parent subtree');
  ok(await isInSubtree(P, P), 'account is in its own subtree');
  ok(!(await isInSubtree(P, OTHER)), 'unrelated account is NOT in subtree');
  ok(!(await isInSubtree(C1, C2)), 'sibling is not in a child subtree');
  ok((await accountSubtree(G)).length === 1, 'leaf subtree is just itself');

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
