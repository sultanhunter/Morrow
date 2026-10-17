import test from 'node:test';
import assert from 'node:assert/strict';
import {read} from '../scripts/foundation.mjs';
import {validateProviders,inspectReadiness,inspectSyntheticActivation} from '../scripts/provider-checks.mjs';

const registry=read('docs/decisions/providers.json'),bindings=read('docs/decisions/provider-bindings.json'),catalogue=read('docs/contracts/capabilities.json'),deps=read('docs/decisions/dependencies.json'),sources=read('docs/research/sources.json');
const validate=(r,b)=>validateProviders(r,b,catalogue,deps,sources);
test('every advertised capability has a gated provider/implementation route',()=>assert.deepEqual(validate(registry,bindings),[]));
for(const [name,change,expected] of [
  ['missing capability route',(_,b)=>b.bindings.pop(),/missing provider binding/],
  ['duplicate route',(_,b)=>b.bindings.push(structuredClone(b.bindings[0])),/duplicate binding/],
  ['malformed decision revision',(r)=>r.plan_sequence='67',/unrecorded provider decision/],
  ['untracked provider',(_,b)=>b.bindings[0].provider='invented',/unknown capability\/provider/],
  ['wrong dependency',(_,b)=>b.bindings[0].provider_dependency='D02',/wrong decision linkage/],
  ['unqualified activation',(r)=>r.providers[0].activation='active',/unsupported activation/],
  ['fabricated engineering',(r)=>r.providers[0].engineering_status='qualified',/unsupported activation/],
  ['fabricated account test',(r)=>r.providers[0].controlled_test_status='passed',/unsupported activation/],
  ['claiming login is grant',(r)=>r.providers.find(p=>p.id==='cloudflare').production_review_status='granted',/unsupported activation/],
  ['latest API',(_,b)=>b.bindings.find(x=>x.mode==='api').version='latest',/unpinned provider/],
  ['blanket scope',(_,b)=>b.bindings.find(x=>x.mode==='api').required_scopes=['write:all'],/unrestricted/],
  ['connector domain exposure',(_,b)=>b.bindings[0].hosts=['shopify_connector'],/surface drift/],
  ['missing readback',(_,b)=>b.bindings[0].readback='',/outcome contract/],
  ['unverified primary source',(_,b)=>b.bindings.find(x=>x.provider==='meta').sources=['S08'],/unverified documentary source/],
  ['invented evidence',(r)=>r.providers[0].qualification_evidence=['fake'],/unsupported activation/],
])test(`provider register rejects ${name}`,()=>{const r=structuredClone(registry),b=structuredClone(bindings);change(r,b);assert.match(validate(r,b).join('\n'),expected);});

const decisions=[{id:'hosting',status:'recorded',reviewRef:'synthetic:hosting-review'},{id:'billing',status:'recorded',reviewRef:'synthetic:billing-review'}];
const localPacket={consumedDecisions:['hosting','billing'],acceptanceIds:['P01.A04'],verification:['synthetic command'],requiresControlledAccount:false,requiresQualifiedPackage:false};
test('recorded designs permit independent local preparation without claiming activation',()=>assert.equal(inspectReadiness(localPacket,decisions).ready,true));
for(const state of ['open','proposed','rejected',undefined]) test(`Ready denied for structural decision ${state}`,()=>{const d=structuredClone(decisions);d[1].status=state;assert.ok(inspectReadiness(localPacket,d).reasons.includes('STRUCTURAL_DECISION_UNRESOLVED:billing'));});
test('a decision without review evidence cannot promote Ready',()=>{const d=structuredClone(decisions);d[1].reviewRef=null;assert.equal(inspectReadiness(localPacket,d).ready,false);});
test('missing required account blocks a controlled test, not independent research',()=>assert.ok(inspectReadiness({...localPacket,requiresControlledAccount:true},decisions).reasons.includes('CONTROLLED_ACCOUNT_MISSING')));
test('selected design cannot replace required package qualification',()=>assert.ok(inspectReadiness({...localPacket,requiresQualifiedPackage:true,packageInputStatus:'in_review'},decisions).reasons.includes('PACKAGE_INPUT_UNQUALIFIED')));
test('unknown structural decision denies Ready',()=>assert.equal(inspectReadiness({...localPacket,consumedDecisions:['unknown']},decisions).ready,false));

for(const host of ['shopify_admin','standalone']) {
  const facts={host,engineering:'qualified',controlledTest:'passed',productionReviewRequired:true,productionReview:'granted',productionReviewRef:'synthetic:receipt',currentAccountPermission:true,currentActorPermission:true,currentRegionAndRetention:true,requiresSpend:true,budgetReserved:true,requiresReview:true,exactCurrentApproval:true,remainingStructuralGap:false};
  test(`${host}: surface gate remains enforced with otherwise qualified synthetic facts`,()=>assert.equal(inspectSyntheticActivation(facts).allowed,host==='standalone'));
  for(const [name,delta,reason] of [
    ['production permission pending',{productionReview:'pending'},'PRODUCTION_PERMISSION_PENDING'],
    ['no review receipt',{productionReviewRef:null},'PRODUCTION_PERMISSION_PENDING'],
    ['only documentary design',{engineering:'not_implemented'},'ENGINEERING_UNQUALIFIED'],
    ['no controlled test',{controlledTest:'not_run'},'CONTROLLED_TEST_UNQUALIFIED'],
    ['merchant account revoked',{currentAccountPermission:false},'ACCOUNT_PERMISSION_MISSING'],
    ['specialist lacks authority',{currentActorPermission:false},'ACTOR_PERMISSION_MISSING'],
    ['US database alone',{currentRegionAndRetention:false},'DATA_POLICY_UNQUALIFIED'],
    ['owner infrastructure has no ceiling',{budgetReserved:false},'BUDGET_NOT_RESERVED'],
    ['stale approval',{exactCurrentApproval:false},'EXACT_APPROVAL_MISSING'],
    ['unresolved API field',{remainingStructuralGap:true},'STRUCTURAL_GAP'],
  ])test(`${host}: denies ${name}`,()=>assert.ok(inspectSyntheticActivation({...facts,...delta}).reasons.includes(reason)));
}
