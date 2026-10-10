import {estimateStackComponents} from './stack-cost.mjs';
import {read} from './foundation.mjs';

// Planning arithmetic only. Integer nanodollars avoid rounding each component
// early. Financial reservations and billing are separate production contracts.
const scale=1_000_000_000n;
const decimal=value=>{
  if(typeof value!=='string'||!/^\d+(?:\.\d{1,9})?$/.test(value)) throw new TypeError('Expected nonnegative decimal with <=9 places');
  const [whole,fraction='']=value.split('.');return BigInt(whole)*scale+BigInt(fraction.padEnd(9,'0'));
};
const mul=(a,b)=>a*b/scale;
const format=value=>`${value/scale}.${(value%scale).toString().padStart(9,'0')}`;
export function estimateWarmComponents(model) {
  if(model.status!=='component_estimate_not_complete_quote'||!model.excluded_required_quote_terms.length) throw new Error('A component estimate requires explicit exclusions');
  const r=key=>decimal(model.rates[key].amount),e=model.warm_example;
  const hours=decimal(model.hours_per_month),seconds=hours*3600n;
  const cpu=decimal(e.api_vcpu)*BigInt(e.api_tasks)+decimal(e.worker_vcpu)*BigInt(e.worker_tasks);
  const memory=decimal(e.api_memory_gb)*BigInt(e.api_tasks)+decimal(e.worker_memory_gb)*BigInt(e.worker_tasks);
  const components={
    trusted_compute:mul(seconds,mul(cpu,r('fargate_x86_cpu_second'))+mul(memory,r('fargate_x86_memory_second'))),
    database_minimum:mul(mul(hours,decimal(e.min_acu)*BigInt(e.db_instances)),r('aurora_acu_hour')),
    alb_base:mul(hours,r('alb_hour')),
    cloudflare_standard:r('cloudflare_standard_base')
  };
  return {currency:model.currency,status:model.status,components:Object.fromEntries(Object.entries(components).map(([k,v])=>[k,format(v)])),subtotal:format(Object.values(components).reduce((a,b)=>a+b,0n)),completeQuote:false,provisioningAuthorized:false,exclusions:model.excluded_required_quote_terms};
}
if(process.argv[1]?.endsWith('/cost-estimate.mjs')) { const model=read('docs/decisions/cost-model.json'); console.log(JSON.stringify(estimateStackComponents(model,model.example_usage),null,2)); }
