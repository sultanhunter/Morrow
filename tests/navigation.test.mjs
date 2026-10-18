import test from 'node:test';
import assert from 'node:assert/strict';
import {read} from '../scripts/foundation.mjs';
import {buildWorkspacePath,matchWorkspacePath} from '../scripts/navigation-examples.mjs';
const catalogue=read('docs/contracts/workspace-routes.json');
test('route inventory has unique IDs/patterns and valid parents',()=>{const ids=catalogue.routes.map(r=>r.id);assert.equal(new Set(ids).size,ids.length);assert.equal(new Set(catalogue.routes.map(r=>r.pattern)).size,ids.length);for(const r of catalogue.routes){assert.ok(r.parent===null||ids.includes(r.parent));assert.ok(r.components.length&&r.data.length);}});
for(const r of catalogue.routes) test('round trip canonical route '+r.id,()=>{const params=Object.fromEntries([...r.pattern.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map(m=>[m[1],r.parameter_enums?.[m[1]]?.[0]??'opaque:123']));const host=r.hosts[0];const url=buildWorkspacePath(catalogue,r.id,params,host);assert.deepEqual(matchWorkspacePath(catalogue,url,host),{id:r.id,params});});
test('static builder route wins over dynamic agent route',()=>assert.equal(matchWorkspacePath(catalogue,'/w/workspace-1/agents/new').id,'builder'));
test('reserved static slug cannot masquerade as an agent identity',()=>assert.throws(()=>buildWorkspacePath(catalogue,'agent',{workspaceId:'workspace-1',installationId:'new'}),/ROUTE_PARAMETERS_INVALID/));
test('builder draft resolves its exact detail rather than an installation',()=>assert.equal(matchWorkspacePath(catalogue,'/w/workspace-1/agents/drafts/draft-1').id,'builder_draft'));
for(const host of ['shopify_admin','shopify_connector','operator_console'])test('merchant domain URLs deny surface '+host,()=>{assert.equal(matchWorkspacePath(catalogue,'/w/workspace-1/work/task-1',host),null);assert.throws(()=>buildWorkspacePath(catalogue,'task',{workspaceId:'workspace-1',taskId:'task-1'},host),/ROUTE_SURFACE_DENIED/);});
for(const path of ['/w/workspace-1/work/a%2Fb','/w/workspace-1/work/%2e%2e','/w/workspace-1/work/%FF','//external.example','https://external.example','/w/workspace-1/work/task-1?token=abc','/w/workspace-1/work/task-1#other','/w/workspace-1/settings/api-key','/operator/releases'])test('reject unsafe/unscoped path '+path,()=>assert.equal(matchWorkspacePath(catalogue,path),null));
test('URL params cannot inject a redirect, store change or credential',()=>{assert.throws(()=>buildWorkspacePath(catalogue,'task',{workspaceId:'workspace-1',taskId:'task-1',token:'secret'}),/ROUTE_PARAMETERS_INVALID/);assert.throws(()=>buildWorkspacePath(catalogue,'task',{workspaceId:'workspace-1',taskId:'../store-2'}),/ROUTE_PARAMETERS_INVALID/);});
test('task URL contains stable identity rather than navigation store',()=>assert.equal(buildWorkspacePath(catalogue,'task',{workspaceId:'workspace-1',taskId:'task-1'}),'/w/workspace-1/work/task-1'));
// P01.T02c AC10 (ADR-0016): project, project artifact, Ask conversation and access request routes, and the sidebar.
const added={project:'/w/workspace-1/projects/project-1',project_artifact:'/w/workspace-1/projects/project-1/artifacts/artifact-1',ask_conversation:'/w/workspace-1/ask/conversation-1',access_request:'/w/workspace-1/inbox/access-requests/request-1'};
test('AC10: the four collaboration routes round-trip with full route metadata',()=>{
  const states=catalogue.routes.find(r=>r.id==='task').states;
  for(const [id,path] of Object.entries(added)){
    const r=catalogue.routes.find(x=>x.id===id);
    assert.deepEqual([r.journey,r.hosts,r.namespace,r.ui_status,r.states],['J01',['standalone'],'merchant','P02 must qualify interactions',states],id);
    assert.ok(r.title&&r.data.length&&r.components.length,id);
    const match=matchWorkspacePath(catalogue,path);
    assert.equal(match.id,id);
    assert.equal(buildWorkspacePath(catalogue,id,match.params),path);
  }
  assert.deepEqual(Object.fromEntries(Object.keys(added).map(id=>[id,catalogue.routes.find(r=>r.id===id).parent])),{project:'work',project_artifact:'project',ask_conversation:'ask',access_request:'inbox'});
  assert.ok(catalogue.routes.find(r=>r.id==='ask_conversation').components.includes('AskPrivacyNotice'));
});
for(const path of ['/w/ws/projects','/w/ws/projects/p1/artifacts','/w/ws/inbox/access/r1','/w/ws/projects/p1?tab=2','/w/ws/projects/p1%2Fx','/w/ws/projects/p1#tab'])test('AC10: no route for '+path,()=>assert.equal(matchWorkspacePath(catalogue,path),null));
test('AC10: the sidebar is the seven destinations with Ask as an action',()=>{
  const s=catalogue.sidebar,ids=new Set(catalogue.routes.map(r=>r.id));
  assert.deepEqual(s.primary.map(p=>p.id),['home','work','inbox','agents','assets','knowledge','settings']);
  assert.equal(s.entry_action,'ask');
  assert.ok(!s.primary.some(p=>p.id==='ask'||p.route==='ask'));
  for(const t of [...s.primary,...s.people_and_agents,...s.footer])assert.ok(ids.has(t.route),t.id);
  assert.deepEqual([s.pinned_projects.route,s.pinned_projects.maximum,s.pinned_projects.breadcrumb_parent],['project',20,'work']);
  assert.equal(s.primary.find(p=>p.id==='inbox').badge,'open_inbox_items');
  assert.ok(s.footer.find(f=>f.id==='credit_balance').display_only);
  assert.ok(!catalogue.routes.some(r=>r.pattern==='/w/:workspaceId/projects'));
});
