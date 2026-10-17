import test from 'node:test';
import assert from 'node:assert/strict';
import {read} from '../scripts/foundation.mjs';
import {digest,proposalDigest,validators,bodyValidators,checkFixture} from '../scripts/contract-checks.mjs';

for (const f of read('docs/contracts/fixtures/P01.A02.json')) test(f.id,()=>assert.equal(checkFixture(f),true));
// Contract v1.1 (P01.T02a): exact-selector schema cases for the kill-switch types and bodies.
for (const f of read('docs/contracts/fixtures/P01.T02a.json')) test(f.id,()=>assert.equal(checkFixture(f),true));
test('canonical digest ignores JSON property order',()=>assert.equal(digest({a:1,b:2}),digest({b:2,a:1})));
test('canonical digest preserves array ordering',()=>assert.notEqual(digest(['product-a','product-b']),digest(['product-b','product-a'])));
test('approved parameters and costs change proposal digest',()=>{
 const f=read('docs/contracts/fixtures/P01.A02.json').find(f=>f.kind==='binding');
 const changed=structuredClone(f.context.proposal);changed.maximumCost={amount:'10.00',currency:'USD'};
 assert.notEqual(proposalDigest(changed),f.context.proposal.proposalDigest);
});
test('non-JSON infinity cannot be hashed as a valid approval',()=>assert.throws(()=>digest({amount:Infinity})));
test('capability body schemas reject credential smuggling',()=>{
 const f=read('docs/contracts/fixtures/P01.A02.json').find(f=>f.kind==='binding');
 const input={proposalRef:f.context.approval.proposalRef,approvalRef:{...f.context.approval.proposalRef,kind:'approval',id:'approval-a'},apiKey:'fixture-not-secret'};
 assert.equal(bodyValidators['catalog.content.publish.input'](input),false);
});
test('retention policy cannot become arbitrary freeform JSON',()=>assert.equal(validators.RetentionPolicy({allowEverything:true}),false));
