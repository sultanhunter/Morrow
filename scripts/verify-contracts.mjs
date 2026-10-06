import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {root,read,sha} from './foundation.mjs';
import {core,bodies,validators,bodyValidators,checkFixture} from './contract-checks.mjs';

const fixtures=read('docs/contracts/fixtures/P01.A02.json');
const errors=[];
const results=fixtures.map(f=>{const passed=checkFixture(f);if (!passed) errors.push(f.id);return {id:f.id,kind:f.kind,passed};});
const transitions=read('docs/contracts/state-transitions.json');
const enumDefs={goal:'GoalStatus',task:'TaskStatus',run:'RunStatus',question:'QuestionStatus',approval:'ApprovalStatus',operation:'OperationStatus',artifact:null,installation:'InstallationStatus'};
for (const [aggregate,rows] of Object.entries(transitions.transitions)) {
  const states=enumDefs[aggregate]?core.$defs[enumDefs[aggregate]].enum:['uploading','processing','ready','failed','quarantined','deleted'];
  for (const t of rows) if (!states.includes(t.from)||!states.includes(t.to)||!t.guard||!t.actor) errors.push('invalid transition '+aggregate);
}
const routes=read('docs/contracts/workspace-routes.json');
for (const r of routes.routes) if (r.namespace==='merchant'&&JSON.stringify(r.hosts.sort())!==JSON.stringify(['standalone'])) errors.push('route surface '+r.id);
const report={task:'P01.T02',generated_at:new Date().toISOString(),plan_sequence:read('docs/plan/source.json').sources.plan.sequence,schema_definitions:Object.keys(validators).length,capability_bodies:Object.keys(bodyValidators).length,state_transitions:Object.values(transitions.transitions).reduce((n,rows)=>n+rows.length,0),routes:routes.routes.length,cases:results.length,scope:'Versioned schema and semantic examples only; no production policy/authentication or provider qualification.',input_digests:Object.fromEntries(['docs/contracts/schemas/v1/core.schema.json','docs/contracts/schemas/v1/capabilities.schema.json','docs/contracts/fixtures/P01.A02.json','package-lock.json'].map(p=>[p,sha(readFileSync(resolve(root,p)))])),errors,results};
mkdirSync(resolve(root,'docs/evidence/P01.T02'),{recursive:true});
writeFileSync(resolve(root,'docs/evidence/P01.T02/verification.json'),JSON.stringify(report,null,2)+'\n');
if (errors.length) {console.error(errors.join('\n'));process.exitCode=1;}
else console.log(`PASS: ${report.schema_definitions} schema definitions, ${report.capability_bodies} capability bodies, ${report.state_transitions} transitions, ${report.cases} contract cases.`);
