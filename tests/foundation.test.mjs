import test from 'node:test';
import assert from 'node:assert/strict';
import {read,validateCatalogue,inspectAuthority} from '../scripts/foundation.mjs';

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
for (const fixture of read('docs/acceptance/P01.A01-fixtures.json')) test(fixture.id,()=>{
  const c=catalogue.capabilities.find(c=>c.id===fixture.capability);
  const actual=inspectAuthority(c,fixture.request);
  assert.equal(actual.allowed,fixture.expected.allowed);
  assert.deepEqual(actual.reasons.sort(),fixture.expected.reasons.sort());
});
