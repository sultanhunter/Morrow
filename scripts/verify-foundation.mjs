import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, read, sha, validateCatalogue, inspectAuthority } from './foundation.mjs';
import { renderDocuments } from './render-catalogue.mjs';
import { writeArtifact } from './artifacts.mjs';

const catalogue = read('docs/contracts/capabilities.json');
const deps = read('docs/decisions/dependencies.json');
const tasks = read('docs/progress/tasks.json');
const types = read('docs/contracts/schema-types.json');
const source = read('docs/plan/source.json');
const errors = validateCatalogue(catalogue,deps,tasks,types);
const readText = path => readFileSync(resolve(root,path),'utf8');
for (const [key,s] of Object.entries(source.sources)) {
  if (sha(readText(s.path)) !== s.sha256) errors.push(`snapshot hash mismatch: ${key}`);
}
const plan = readText(source.sources.plan.path);
if (source.canonical_key !== 'plan' || source.sources.plan.page_id !== 'page_b1ef27b80b788191b91e67cbb52f1037') errors.push('wrong canonical source');
const ids = pattern => [...new Set(plan.match(pattern) ?? [])];
const expectedTasks = ids(/P\d{2}\.T\d{2}(?![a-z\d])/g);
const expectedCases = ids(/P\d{2}\.A\d{2}(?![a-z\d])/g);
if (JSON.stringify(tasks.tasks.map(t=>t.id)) !== JSON.stringify(expectedTasks)) errors.push('task inventory drift');
if (JSON.stringify(tasks.acceptance_ids) !== JSON.stringify(expectedCases)) errors.push('acceptance inventory drift');
if (new Set(tasks.tasks.map(t=>t.id.slice(0,3))).size !== 18) errors.push('package count drift');
if (catalogue.plan_sequence !== source.sources.plan.sequence || tasks.plan_sequence !== source.sources.plan.sequence) errors.push('plan revision mismatch');
for (const [file,text] of Object.entries(renderDocuments(catalogue,deps))) if (readText(`docs/contracts/${file}`) !== text) errors.push(`stale generated record: ${file}`);
const cases = read('docs/acceptance/P01.A01-fixtures.json');
const results = cases.map(test=>{
  const c = catalogue.capabilities.find(c=>c.id===test.capability);
  if (!c) { errors.push(`unknown fixture capability ${test.capability}`); return {id:test.id,passed:false}; }
  const actual=inspectAuthority(c,test.request);
  const passed=actual.allowed===test.expected.allowed && JSON.stringify([...actual.reasons].sort())===JSON.stringify([...test.expected.reasons].sort());
  if (!passed) errors.push(`walkthrough failed ${test.id}`);
  return {id:test.id,capability:c.id,host:test.request.host,expected:test.expected,actual,passed};
});
const report = {task:'P01.T01',generated_at:new Date().toISOString(),plan_sequence:source.sources.plan.sequence,plan_digest:source.sources.plan.sha256,capabilities:catalogue.capabilities.length,domains:catalogue.domain_names.length,packages:18,tasks:expectedTasks.length,acceptance_cases:expectedCases.length,walkthrough_cases:results.length,scope:'Catalogue consistency and synthetic authority walkthroughs only; not production enforcement or provider qualification.',input_digests:Object.fromEntries(['docs/contracts/capabilities.json','docs/decisions/dependencies.json','docs/acceptance/P01.A01-fixtures.json'].map(p=>[p,sha(readText(p))])),errors,results};
writeArtifact('verify/foundation.json',report);
if (errors.length) { console.error(errors.join('\n'));process.exitCode=1; }
else console.log(`PASS: ${report.capabilities} capabilities, ${report.domains} domains, ${report.tasks} tasks, ${report.walkthrough_cases} synthetic walkthrough cases. Production gates remain pending.`);
