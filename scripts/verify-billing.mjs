import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {root,read,sha} from './foundation.mjs';
import {allocationDigest,ContractCreditLedger,billing} from './billing-checks.mjs';
import {inspectReadiness} from './provider-checks.mjs';
import {writeArtifact} from './artifacts.mjs';

const source=read('docs/plan/source.json'),f=read('docs/contracts/fixtures/P01.A04.json');
f.allocation.allocationDigest=allocationDigest(f.allocation);f.facts.approvedAllocationDigest=f.allocation.allocationDigest;
const checks=[],errors=[];
function check(name,run) {try{if(!run())throw new Error('unexpected outcome');checks.push({name,passed:true});}catch(e){checks.push({name,passed:false});errors.push(name+': '+e.message);}}
check('small brand retains installation payer',()=>{
  const x=structuredClone(f);x.allocation.shares.splice(1);x.allocation.maximumCredits='30';x.allocation.allocationDigest=allocationDigest(x.allocation);x.facts.approvedAllocationDigest=x.allocation.allocationDigest;
  const l=new ContractCreditLedger(x.facts);l.reserve('reservation-1',x.allocation,x.vendorReservation);
  return l.snapshot().wallets['payer-1'].available==='70'&&l.snapshot().wallets['payer-2'].available==='100';
});
check('specialist team reconciles two payers and one vendor cost',()=>{
  const l=new ContractCreditLedger(f.facts);l.reserve('reservation-1',f.allocation,f.vendorReservation);l.dispatch('reservation-1');l.uncertain('reservation-1');l.settle('reservation-1',f.usage,{verifiedProviderEvidence:true,verifiedRateEvidence:true});
  const s=l.snapshot();return s.rootConsumed==='25'&&s.rootReserved==='0'&&s.vendorConsumed==='300000000'&&s.wallets['payer-2'].available==='90';
});
check('unqualified real billing design cannot dispatch',()=>{
  const x=structuredClone(f);x.facts.rateQualified=false;const l=new ContractCreditLedger(x.facts);try{l.reserve('reservation-1',x.allocation,x.vendorReservation);}catch(e){return e.message.includes('RATE_NOT_QUALIFIED');}return false;
});
const decisions=read('docs/decisions/readiness.json');
check('local design packet ready with pending external reviews',()=>inspectReadiness(decisions.local_design_packet,decisions.consumed_decisions).ready);
check('unresolved consumed structural decision blocks Ready',()=>{
  const copy=structuredClone(decisions.consumed_decisions);copy[0].status='unresolved';return !inspectReadiness(decisions.local_design_packet,copy).ready;
});
check('missing controlled account still blocks integrated qualification',()=>!inspectReadiness({...decisions.local_design_packet,requiresControlledAccount:true},decisions.consumed_decisions).ready);
check('unqualified package still blocks consumers',()=>!inspectReadiness({...decisions.local_design_packet,requiresQualifiedPackage:true,packageInputStatus:'in_review'},decisions.consumed_decisions).ready);
for(const d of decisions.consumed_decisions) {
  const original=read('docs/decisions/dependencies.json').find(x=>x.id===d.id);
  if(!original||original.status!=='Design recorded'||original.activation!=='blocked_until_qualified')errors.push('readiness/activation drift '+d.id);
  if(!d.reviewRef||d.reviewDigest!==sha(readFileSync(resolve(root,d.reviewRef),'utf8')))errors.push('review receipt changed '+d.id);
}
const inputs=['docs/contracts/schemas/v1/billing.schema.json','docs/contracts/fixtures/P01.A04.json','docs/contracts/billing-entitlements.md','docs/contracts/budgets.md','docs/decisions/billing-ownership.md','docs/decisions/readiness.json','docs/decisions/reviews/P01.T04-review.md','scripts/billing-checks.mjs','tests/billing.test.mjs'];
const report={task:'P01.T04',generated_at:new Date().toISOString(),plan_sequence:source.sources.plan.sequence,billing_definitions:Object.keys(billing.$defs).length,checks,scope:'Synthetic design, exact arithmetic and semantic walkthroughs only. No concurrent database, rate activation, provider charge, independent review or merchant usability proof.',input_digests:Object.fromEntries(inputs.map(p=>[p,sha(readFileSync(resolve(root,p),'utf8'))])),errors};
writeArtifact('verify/billing.json',report);
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log(`PASS: ${report.billing_definitions} billing definitions and ${checks.length} billing/readiness walkthroughs. Billing activation remains blocked.`);
