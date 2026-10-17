import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {root,read,validateCatalogue,validateTasks,inspectAuthority,planInventory,TASK_STATUSES} from '../scripts/foundation.mjs';

const catalogue=read('docs/contracts/capabilities.json');
const dependencies=read('docs/decisions/dependencies.json');
const tasks=read('docs/progress/tasks.json');
const types=read('docs/contracts/schema-types.json');
const validate=c=>validateCatalogue(c,dependencies,tasks,types);
test('catalogue satisfies domain and traceability contracts',()=>assert.deepEqual(validate(catalogue),[]));
for (const [name,mutate,expected] of [
  ['untracked provider',c=>c.capabilities[0].provider_dependency='unknown',/untracked provider/],
  ['duplicate operation',c=>c.capabilities.push(structuredClone(c.capabilities[0])),/duplicate capability/],
  ['missing launch domain',c=>c.capabilities=c.capabilities.filter(x=>x.domain!=='Finance'),/missing launch domain/],
  ['premature capability activation',c=>c.capabilities[0].activation='active',/premature activation/],
  ['missing review gate',c=>c.capabilities.find(x=>x.effect==='spend').review_required=false,/without review gate/],
  ['connector domain exposure',c=>c.capabilities[0].hosts=['shopify_connector'],/standalone surface/],
  ['unbounded fields',c=>c.capabilities[0].field_scope=['*'],/unrestricted fields/],
  ['invented implementation task',c=>c.capabilities[0].implementation_tasks=['P99.T01'],/unknown implementation/],
  ['unknown nested type',c=>Object.values(c.capabilities[0].input.fields)[0].type='Unknown',/invalid input/],
]) test(`rejects ${name}`,()=>{const c=structuredClone(catalogue);mutate(c);assert.match(validate(c).join('\n'),expected);});
test('task records use the plan status vocabulary',()=>{
  assert.deepEqual(validateTasks(tasks),[]);
  assert.ok(TASK_STATUSES.includes('Self-reviewed'));
});
for (const [name,mutate,expected] of [
  ['unknown status',t=>t.tasks[0].status='Done',/P01\.T01: unknown status "Done"/],
  ['missing status',t=>delete t.tasks[0].status,/exactly id and status[\s\S]*unknown status undefined/],
  ['extra task field',t=>t.tasks[0].reviewTier='self',/P01\.T01: task record must have exactly id and status/],
  ['duplicate task',t=>t.tasks.push(structuredClone(t.tasks[0])),/duplicate task ID: P01\.T01/],
  ['malformed task ID',t=>t.tasks[0].id='P1.T1',/invalid or duplicate task ID: P1\.T1/],
  ['duplicate acceptance ID',t=>t.acceptance_ids.push('P01.A01'),/duplicate acceptance ID: P01\.A01/],
]) test(`task validation rejects ${name}`,()=>{const t=structuredClone(tasks);mutate(t);assert.match(validateTasks(t).join('\n'),expected);});
test('plan definitions equal tasks.json in order',()=>{
  const inventory=planInventory(readFileSync(`${root}/docs/plan/build-plan.md`,'utf8'));
  assert.deepEqual(inventory.tasks,tasks.tasks.map(t=>t.id));
  assert.deepEqual(inventory.cases,tasks.acceptance_ids);
  const sample=planInventory('Plan status: P02.T04 first.\n1. **P01.T01 Catalogue.** **P01.A01:** case.\n2. **P01.T02 State.**\n7. **P01.T02a child** is not a parent.\n');
  assert.deepEqual(sample.tasks,['P01.T01','P01.T02']);
  assert.deepEqual(sample.cases,['P01.A01']);
  assert.deepEqual(sample.mentionedTasks,['P02.T04','P01.T01','P01.T02']);
});
for (const fixture of read('docs/acceptance/P01.A01-fixtures.json')) test(fixture.id,()=>{
  const c=catalogue.capabilities.find(c=>c.id===fixture.capability);
  const actual=inspectAuthority(c,fixture.request);
  assert.equal(actual.allowed,fixture.expected.allowed);
  assert.deepEqual(actual.reasons.sort(),fixture.expected.reasons.sort());
});
