import {ajv,digest} from './contract-checks.mjs';
import {read} from './foundation.mjs';

export const billing=read('docs/contracts/schemas/v1/billing.schema.json');
ajv.addSchema(billing);
export const billingValidators=Object.fromEntries(Object.keys(billing.$defs).map(k=>[k,ajv.compile({$ref:billing.$id+'#/$defs/'+k})]));
const assert=(condition,reason)=>{if(!condition)throw new Error(reason);};
export function units(value) {
  assert(billingValidators.CreditUnits(value),'CREDIT_UNITS_INVALID');
  return BigInt(value);
}
export function money(value) {
  assert(billingValidators.BillingMoney(value),'MONEY_INVALID');
  const [whole,fraction='']=value.amount.split('.');
  return BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'));
}
export const allocationDigest=allocation=>{const {allocationDigest,...payload}=allocation;return digest(payload);};
export const meterDigest=event=>{const {payloadDigest,status,attemptCount,providerReceiptRef,...payload}=event;return digest(payload);};
const sameScope=(a,b)=>a.organizationId===b.organizationId&&a.workspaceId===b.workspaceId;
const matchesPayer=(a,b)=>a.billingAccountId===b.id&&a.installationId===b.installationId&&a.storeId===b.storeId;
const validTime=value=>Number.isFinite(Date.parse(value));

// Trusted facts in these examples are fixture inputs, never a browser/model authority claim.
export function inspectAllocation(allocation,facts,{checkAvailable=true}={}) {
  const errors=[];
  if(!billingValidators.CostAllocation(allocation))return ['ALLOCATION_SCHEMA_INVALID'];
  if(!validTime(facts.now))return ['SERVER_TIME_INVALID'];
  if(!facts.authenticated||!facts.currentMembership||!facts.spendingGrant)errors.push('SPENDING_AUTHORITY_DENIED');
  if(!facts.providerQualified)errors.push('PROVIDER_NOT_QUALIFIED');
  if(!facts.rateQualified||!facts.economicAdmission)errors.push('RATE_NOT_QUALIFIED');
  if(!sameScope(allocation,facts)||allocation.rootRunId!==facts.rootRunId||allocation.taskId!==facts.taskId)errors.push('ALLOCATION_SCOPE_MISMATCH');
  if(allocation.allocationDigest!==allocationDigest(allocation)||allocation.allocationDigest!==facts.approvedAllocationDigest)errors.push('ALLOCATION_REVIEW_CHANGED');
  if(allocation.rateRevision!==facts.rateRevision||allocation.meterKey!==facts.meterKey)errors.push('RATE_CHANGED');
  if(new Set(allocation.shares.map(s=>s.billingAccountId)).size!==allocation.shares.length||new Set(allocation.shares.map(s=>s.storeId)).size!==allocation.shares.length)errors.push('DUPLICATE_PAYER_OR_STORE');
  if(allocation.shares.reduce((sum,s)=>sum+units(s.maximumCredits),0n)!==units(allocation.maximumCredits))errors.push('ALLOCATION_TOTAL_MISMATCH');
  for(const share of allocation.shares) {
    const account=facts.accounts?.[share.billingAccountId],entitlement=facts.entitlements?.[share.billingAccountId],wallet=facts.wallets?.[share.billingAccountId];
    if(!billingValidators.BillingAccount(account)||!billingValidators.EntitlementSnapshot(entitlement)||!billingValidators.CreditWallet(wallet)) { errors.push('PAYER_FACTS_INVALID');continue; }
    if(!sameScope(account,allocation)||!matchesPayer(share,account)||!facts.authorizedStoreIds?.includes(share.storeId))errors.push('PAYER_SCOPE_DENIED');
    if(account.status!=='active'||entitlement.status!=='active')errors.push('PAYER_INACTIVE');
    if(!sameScope(entitlement,account)||!matchesPayer(entitlement,account)||entitlement.revision!==share.entitlementRevision||entitlement.revision!==facts.entitlementRevisions?.[account.id]||entitlement.providerEvidenceRef!==facts.entitlementEvidence?.[account.id])errors.push('ENTITLEMENT_NOT_CURRENT');
    if(Date.parse(entitlement.verifiedAt)>Date.parse(facts.now)||Date.parse(entitlement.validUntil)<=Date.parse(facts.now)||Date.parse(entitlement.validUntil)<=Date.parse(entitlement.verifiedAt))errors.push('ENTITLEMENT_EXPIRED');
    if(wallet.billingAccountId!==account.id||wallet.rateRevision!==allocation.rateRevision||wallet.termsRevision!==facts.termsRevision)errors.push('WALLET_REVISION_CHANGED');
    if(checkAvailable&&units(share.maximumCredits)>units(wallet.available))errors.push('CREDITS_EXHAUSTED');
    const ceiling=facts.monetaryCeilings?.[account.id];
    if(!billingValidators.BillingMoney(ceiling)||account.currency!==share.maximumLiability.currency||ceiling?.currency!==account.currency||money(share.maximumLiability)>money(ceiling))errors.push('MONETARY_LIMIT_DENIED');
  }
  return [...new Set(errors)];
}

export function inspectUsage(usage) {
  if(!billingValidators.UsageLiability(usage))return ['USAGE_SCHEMA_INVALID'];
  if(usage.providerCostStatus==='known'&&usage.providerCost===null)return ['KNOWN_COST_MISSING'];
  if(usage.providerCostStatus==='uncertain'&&(usage.providerCost!==null||usage.status!=='uncertain'))return ['UNCERTAIN_COST_MISREPRESENTED'];
  if(usage.status==='reconciled'&&usage.providerCostStatus!=='known')return ['UNRECONCILED_PROVIDER_COST'];
  return [];
}
export function inspectMeter(event,usage,entitlement) {
  if(!billingValidators.MeterEvent(event)||inspectUsage(usage).length||!billingValidators.EntitlementSnapshot(entitlement))return ['METER_INPUT_INVALID'];
  const errors=[];
  if(event.payloadDigest!==meterDigest(event))errors.push('METER_PAYLOAD_CHANGED');
  if(event.usageLiabilityId!==usage.id||event.billingAccountId!==usage.billingAccountId||event.billingAccountId!==entitlement.billingAccountId||event.subscriptionId!==entitlement.subscriptionId||event.rateRevision!==usage.rateRevision||event.merchantCredits!==usage.merchantCredits||digest(event.merchantLiability)!==digest(usage.merchantLiability))errors.push('METER_LIABILITY_MISMATCH');
  if(usage.status!=='reconciled')errors.push('USAGE_NOT_RECONCILED');
  if(event.status==='accepted'&&event.providerReceiptRef===null)errors.push('METER_RECEIPT_MISSING');
  if(event.status==='pending'&&event.attemptCount!==0)errors.push('METER_ATTEMPT_INVALID');
  if(event.status!=='pending'&&event.attemptCount===0)errors.push('METER_ATTEMPT_INVALID');
  return [...new Set(errors)];
}

// Deterministic P01 review model. Production requires transactions, durable records,
// authorization services, leases and verified provider readback in later packages.
export class ContractCreditLedger {
  #facts;#reservations=new Map();#usedUsageIds=new Set();#usedOperations=new Set();#meterEvents=new Map();
  #rootReserved=0n;#rootConsumed=0n;#vendorReserved=0n;#vendorConsumed=0n;#payerMoney=new Map();
  constructor(facts) {
    assert(validTime(facts.now),'SERVER_TIME_INVALID');units(facts.rootMaximumCredits);
    money(facts.vendorBudget);assert(Number.isSafeInteger(facts.costScheduleRevision)&&facts.costScheduleRevision>0,'COST_SCHEDULE_INVALID');
    this.#facts=structuredClone(facts);
  }
  snapshot() {
    return structuredClone({wallets:this.#facts.wallets,reservations:[...this.#reservations.values()],rootReserved:this.#rootReserved.toString(),rootConsumed:this.#rootConsumed.toString(),vendorReserved:this.#vendorReserved.toString(),vendorConsumed:this.#vendorConsumed.toString(),payerMoney:Object.fromEntries([...this.#payerMoney].map(([k,v])=>[k,v.toString()])),meterEvents:[...this.#meterEvents.values()]});
  }
  // Simulates fresh trusted server facts; callers cannot grant authority through payloads.
  refresh(facts) {
    const allowed=['now','authenticated','currentMembership','spendingGrant','providerQualified','rateQualified','economicAdmission','accounts','entitlements','entitlementRevisions','entitlementEvidence','authorizedStoreIds','approvedAllocationDigest','rateRevision','meterKey','termsRevision','monetaryCeilings'];
    assert(Object.keys(facts).every(k=>allowed.includes(k)),'REFRESH_FIELD_DENIED');
    this.#facts={...this.#facts,...structuredClone(facts)};
  }
  reserve(id,allocation,vendorReservation) {
    assert(billingValidators.CreditReservation({schemaVersion:1,id,allocationId:allocation?.id,allocationDigest:allocation?.allocationDigest,rootRunId:allocation?.rootRunId,status:'reserved',createdAt:this.#facts.now,settledUsageDigest:null}),'RESERVATION_SCHEMA_INVALID');
    assert(billingValidators.VendorCostReservation(vendorReservation),'VENDOR_RESERVATION_INVALID');
    const existing=this.#reservations.get(id);
    if(existing) {
      assert(digest(existing.allocation)===digest(allocation)&&digest(existing.vendorOriginal)===digest(vendorReservation),'RESERVATION_REPLAY_CONFLICT');
      return structuredClone(existing.record);
    }
    const errors=inspectAllocation(allocation,this.#facts);assert(!errors.length,errors.join(','));
    assert(vendorReservation.status==='reserved'&&vendorReservation.rootRunId===allocation.rootRunId&&vendorReservation.vendorId===this.#facts.vendorId&&vendorReservation.costScheduleRevision===this.#facts.costScheduleRevision&&vendorReservation.maximumCost.currency===this.#facts.vendorBudget.currency,'VENDOR_SCOPE_DENIED');
    assert(![...this.#reservations.values()].some(r=>r.vendorOriginal.id===vendorReservation.id),'VENDOR_RESERVATION_REUSED');
    const credits=units(allocation.maximumCredits),cost=money(vendorReservation.maximumCost);
    assert(this.#rootReserved+this.#rootConsumed+credits<=units(this.#facts.rootMaximumCredits),'ROOT_CREDIT_LIMIT');
    assert(this.#vendorReserved+this.#vendorConsumed+cost<=money(this.#facts.vendorBudget),'VENDOR_COST_LIMIT');
    for(const share of allocation.shares)assert((this.#payerMoney.get(share.billingAccountId)??0n)+money(share.maximumLiability)<=money(this.#facts.monetaryCeilings[share.billingAccountId]),'PAYER_MONETARY_LIMIT');
    for(const share of allocation.shares) {
      const w=this.#facts.wallets[share.billingAccountId];
      assert(units(w.available)+units(w.reserved)+units(w.consumed)<=999999999999999999n&&w.revision<Number.MAX_SAFE_INTEGER-1,'WALLET_RANGE_INVALID');
    }
    // All checks finish before any payer is changed.
    for(const share of allocation.shares) {
      const w=this.#facts.wallets[share.billingAccountId],credits=units(share.maximumCredits);
      w.available=(units(w.available)-credits).toString();w.reserved=(units(w.reserved)+credits).toString();w.revision++;
      this.#payerMoney.set(share.billingAccountId,(this.#payerMoney.get(share.billingAccountId)??0n)+money(share.maximumLiability));
    }
    this.#rootReserved+=credits;this.#vendorReserved+=cost;
    const record={schemaVersion:1,id,allocationId:allocation.id,allocationDigest:allocation.allocationDigest,rootRunId:allocation.rootRunId,status:'reserved',createdAt:this.#facts.now,settledUsageDigest:null};
    const entitlements=Object.fromEntries(allocation.shares.map(s=>[s.billingAccountId,this.#facts.entitlements[s.billingAccountId]]));
    this.#reservations.set(id,structuredClone({record,allocation,vendorOriginal:vendorReservation,entitlements}));
    return structuredClone(record);
  }
  #get(id) {const r=this.#reservations.get(id);assert(r,'RESERVATION_NOT_FOUND');return r;}
  dispatch(id) {
    const r=this.#get(id);assert(r.record.status==='reserved','DISPATCH_STATE_INVALID');
    const errors=inspectAllocation(r.allocation,this.#facts,{checkAvailable:false});assert(!errors.length,errors.join(','));
    r.record.status='dispatched';return structuredClone(r.record);
  }
  uncertain(id) {
    const r=this.#get(id);assert(['dispatched','uncertain'].includes(r.record.status),'UNCERTAIN_STATE_INVALID');
    r.record.status='uncertain';return structuredClone(r.record);
  }
  release(id) {
    const r=this.#get(id);if(r.record.status==='released')return structuredClone(r.record);
    assert(r.record.status==='reserved','SUBMITTED_LIABILITY_RETAINED');
    this.#applySettlement(r,r.allocation.shares.map(s=>({billingAccountId:s.billingAccountId,merchantCredits:'0',merchantLiability:{currency:s.maximumLiability.currency,amount:'0'}})),0n);
    r.record.status='released';return structuredClone(r.record);
  }
  settle(id,usage,{verifiedProviderEvidence=false,verifiedRateEvidence=false}={}) {
    const r=this.#get(id);assert(Array.isArray(usage),'USAGE_LIST_INVALID');const usageDigest=digest(usage);
    if(r.record.status==='settled') {assert(r.record.settledUsageDigest===usageDigest,'SETTLEMENT_REPLAY_CONFLICT');return structuredClone(r.record);}
    assert(['dispatched','uncertain'].includes(r.record.status),'SETTLEMENT_STATE_INVALID');
    assert(verifiedProviderEvidence&&verifiedRateEvidence,'SETTLEMENT_EVIDENCE_REQUIRED');
    assert(usage.length===r.allocation.shares.length&&new Set(usage.map(u=>u.billingAccountId)).size===usage.length,'USAGE_PAYER_SET_INVALID');
    let actualCost=0n;const ids=new Set(),operations=new Set();
    for(const u of usage) {
      assert(!inspectUsage(u).length&&u.status==='reconciled'&&u.providerCostStatus==='known','USAGE_UNRECONCILED');
      const share=r.allocation.shares.find(s=>s.billingAccountId===u.billingAccountId);
      assert(share&&u.reservationId===id&&u.rateRevision===r.allocation.rateRevision,'USAGE_BINDING_INVALID');
      assert(u.merchantLiability.currency===share.maximumLiability.currency&&units(u.merchantCredits)<=units(share.maximumCredits)&&money(u.merchantLiability)<=money(share.maximumLiability),'USAGE_EXCEEDS_RESERVATION');
      assert(u.providerCost.currency===r.vendorOriginal.maximumCost.currency,'PROVIDER_CURRENCY_MISMATCH');
      assert(validTime(u.observedAt)&&Date.parse(u.observedAt)<=Date.parse(this.#facts.now),'USAGE_TIME_INVALID');
      const operationKey=u.billingAccountId+':'+u.operationId;
      assert(!ids.has(u.id)&&!this.#usedUsageIds.has(u.id)&&!operations.has(operationKey)&&!this.#usedOperations.has(operationKey),'DUPLICATE_USAGE');
      ids.add(u.id);operations.add(operationKey);actualCost+=money(u.providerCost);
    }
    assert(actualCost<=money(r.vendorOriginal.maximumCost),'PROVIDER_COST_EXCEEDS_RESERVATION');
    this.#applySettlement(r,usage,actualCost);
    for(const key of ids)this.#usedUsageIds.add(key);for(const key of operations)this.#usedOperations.add(key);
    r.record.status='settled';r.record.settledUsageDigest=usageDigest;r.usage=structuredClone(usage);
    return structuredClone(r.record);
  }
  #applySettlement(r,usage,actualCost) {
    for(const u of usage)assert(this.#facts.wallets[u.billingAccountId].revision<Number.MAX_SAFE_INTEGER,'WALLET_REVISION_EXHAUSTED');
    let actualCredits=0n;
    for(const u of usage) {
      const s=r.allocation.shares.find(s=>s.billingAccountId===u.billingAccountId),w=this.#facts.wallets[u.billingAccountId];
      const reserved=units(s.maximumCredits),used=units(u.merchantCredits);actualCredits+=used;
      w.available=(units(w.available)+reserved-used).toString();w.reserved=(units(w.reserved)-reserved).toString();w.consumed=(units(w.consumed)+used).toString();w.revision++;
      this.#payerMoney.set(u.billingAccountId,this.#payerMoney.get(u.billingAccountId)-money(s.maximumLiability)+money(u.merchantLiability));
    }
    this.#rootReserved-=units(r.allocation.maximumCredits);this.#rootConsumed+=actualCredits;
    this.#vendorReserved-=money(r.vendorOriginal.maximumCost);this.#vendorConsumed+=actualCost;
  }
  recordMeter(event) {
    const r=[...this.#reservations.values()].find(r=>r.usage?.some(u=>u.id===event.usageLiabilityId));
    const usage=r?.usage.find(u=>u.id===event.usageLiabilityId);
    const entitlement=r?.entitlements[event.billingAccountId];
    assert(!inspectMeter(event,usage,entitlement).length,'METER_INVALID');
    assert(event.meterKey===r.allocation.meterKey,'METER_KEY_CHANGED');
    const prior=this.#meterEvents.get(event.id);
    if(prior) {
      assert(prior.payloadDigest===event.payloadDigest,'METER_REPLAY_CONFLICT');
      if(digest(prior)===digest(event))return structuredClone(prior);
      const allowed={pending:['submitted'],submitted:['uncertain','accepted','rejected'],uncertain:['accepted','rejected'],accepted:[],rejected:[]};
      assert(allowed[prior.status].includes(event.status),'METER_TRANSITION_DENIED');
      assert(event.attemptCount===(prior.status==='pending'?prior.attemptCount+1:prior.attemptCount),'METER_ATTEMPT_CHANGED');
    } else {
      assert(event.status==='pending'&&![...this.#meterEvents.values()].some(e=>e.usageLiabilityId===event.usageLiabilityId),'METER_DUPLICATE_LIABILITY');
    }
    this.#meterEvents.set(event.id,structuredClone(event));return structuredClone(event);
  }
}
