import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {root,read,sha} from './foundation.mjs';

// Input must be the current FULL Pages read, saved as JSON by the coding agent.
// This tool never edits the Page and never accepts a manually authored Markdown plan.
const input=process.argv[2];
if (!input) throw new Error('Usage: node scripts/sync-plan.mjs /absolute/path/to/full-page-read.json');
const envelope=JSON.parse(readFileSync(resolve(input),'utf8'));
const p=envelope.structuredContent ?? envelope;
const page='page_b1ef27b80b788191b91e67cbb52f1037';
if (p.metadata?.page_id!==page || p.content?.page_id!==page || !Array.isArray(p.content.blocks) || !p.content.markdown || !Number.isInteger(p.metadata.current_sequence)) throw new Error('Expected current full canonical Page read with metadata, complete Markdown and blocks');
if (p.selection && !p.selection.whole_page_complete) throw new Error('Partial reads cannot refresh the full plan');
if (p.metadata.namespace==='meeting_notes') throw new Error('Unexpected Page namespace');
const manifest=read('docs/plan/source.json');
const old=manifest.sources.plan;
const sequence=p.metadata.current_sequence;
if (sequence<old.sequence) throw new Error('Refusing an older snapshot');
const markdown=p.content.markdown;
const digest=sha(markdown);
if (sequence===old.sequence && digest!==old.sha256) throw new Error('Same Page sequence has a different digest; reconcile before refresh');
const tasks=[...new Set(markdown.match(/P\d{2}\.T\d{2}(?![a-z\d])/g)??[])];
if (new Set(tasks.map(x=>x.slice(0,3))).size!==18) throw new Error('18-package invariant changed; resolve the scope decision in the plan first');
manifest.captured_at=new Date().toISOString();
manifest.sources.plan={...old,title:p.content.title,url:p.metadata.url,sequence,sha256:digest};
writeFileSync(resolve(root,old.path),markdown);
writeFileSync(resolve(root,'docs/plan/source.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Plan refreshed at sequence ${sequence}. Compare changes and reconcile consumed revisions, packets and evidence before dependent implementation.`);
