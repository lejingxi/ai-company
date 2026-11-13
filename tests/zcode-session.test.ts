import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readModelConfigSnapshot } from '../src/server/model-catalog.js';
import { ZcodeSessionTransport } from '../src/server/runners/zcode-session.js';
import type { ModelBinding, RunnerInput } from '../src/shared/types.js';

const peer = String.raw`const readline=require('node:readline');
let sessionId='';
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\n');
const snapshot=()=>({protocol:{name:'ZCode Protocol',version:1},session:{sessionId,mode:'build',status:'idle'},settings:{model:{current:{providerId:'provider-a',modelId:'model-a',options:{reasoningLevel:'high'}}},thoughtLevel:{enabled:true,current:'high'},mode:{current:'build'}},runtime:{eventSeq:0,stateRevision:1},messages:[]});
readline.createInterface({input:process.stdin}).on('line',(line)=>{const m=JSON.parse(line); const p=m.params||{};
 if(m.method==='runtime/capabilities') return send({id:m.id,result:{sessionLifecycleWorkspace:true,sessionWorkspaceRouting:true}});
 if(m.method==='session/create'){sessionId=p.sessionId;return send({id:m.id,result:snapshot()});}
 if(m.method==='session/setModel'||m.method==='session/setMode'||m.method==='session/read') return send({id:m.id,result:snapshot()});
 if(m.method==='session/subscribe') return send({id:m.id,result:{sessionId,eventSeq:0,events:[]}});
 if(m.method==='session/send'){send({id:m.id,result:{accepted:true,sessionId,stateRevision:2}});return setTimeout(()=>send({method:'session/event',params:{sessionId,type:'turn.completed',turnId:'turn-1',payload:{resultType:'success',response:JSON.stringify({summary:'synthetic session result',files:[]}),tokenCount:0,toolCallCount:0,duration:1}}}),20);}
 if(m.method==='session/close') return send({id:m.id,result:{closed:true}});
});
setInterval(()=>{},1000);`;

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiyansi-session-'));
  const personal = path.join(directory, 'provider_config.json');
  const builtin = path.join(directory, 'zcode-builtin.json');
  const peerFile = path.join(directory, 'peer.cjs');
  fs.writeFileSync(personal, JSON.stringify({ schemaVersion: 1, config: {
    providerOrder: ['provider-a'],
    providerConfigRules: { providerRules: [{ providerId: 'provider-a', providerName: 'fixture', config: {
      group: 'standard-personal', personalModelIds: ['model-a'], modelOrder: ['model-a'],
      access: { type: 'api-key', apiKey: 'fixture-only-secret' },
      api: { type: 'openai-chat-completions', baseUrl: 'https://fixture.invalid/v1' },
    } }] },
    modelConfigRules: { providerModelRules: [{ providerId: 'provider-a', modelId: 'model-a', config: { optionSpecs: { reasoningLevel: { values: ['low', 'high'] } } } }], manualProviderModelRules: [] },
  } }, null, 2));
  fs.writeFileSync(builtin, JSON.stringify({ schemaVersion: 1, config: { modelConfigRules: {} } }));
  fs.writeFileSync(peerFile, peer);
  const catalog = readModelConfigSnapshot({ configPath: personal, builtinConfigPath: builtin });
  const partial = { providerId: 'provider-a', modelId: 'model-a', catalogId: 'provider-a/model-a', reasoningLevel: 'high', selectionRevision: 1, catalogRevision: catalog.catalog.catalogRevision! };
  const selectionFingerprint = createHash('sha256').update(JSON.stringify([partial.providerId, partial.modelId, partial.catalogId, partial.reasoningLevel, partial.catalogRevision, partial.selectionRevision])).digest('hex');
  const binding: ModelBinding = { ...partial, selectionFingerprint };
  return { directory, personal, builtin, peerFile, binding };
}
function input(directory: string): RunnerInput {
  return { employee: {} as RunnerInput['employee'], task: {} as RunnerInput['task'], project: {} as RunnerInput['project'], stage: 'development', workspace: directory, prompt: 'synthetic', signal: new AbortController().signal };
}

test('native session transport binds exact model/reasoning and closes an owned synthetic session', async t => {
  if (process.platform !== 'win32') { t.skip('Windows read-lock guard'); return; }
  const f = fixture(); t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const transport = new ZcodeSessionTransport({ electronPath: process.execPath, cliPath: f.peerFile, personalConfigPath: f.personal, builtinConfigPath: f.builtin, timeoutMs: 10_000 });
  assert.equal(transport.supports(f.binding).ready, true);
  const controller = new AbortController();
  const result = await transport.invoke(input(f.directory), { electronPath: process.execPath, cliPath: f.peerFile, enabled: true, environmentMode: 'existing-user', timeoutMs: 10_000, modelBinding: f.binding, effectiveReasoningLevel: 'high', personalConfigPath: f.personal, builtinConfigPath: f.builtin }, controller.signal, { prompt: 'synthetic', mode: 'edit', cwd: f.directory, env: process.env, disallowedTools: ['Bash'], maxOutputBytes: 2 * 1024 * 1024 });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.modelEvidence, { providerId: 'provider-a', modelId: 'model-a', reasoningLevel: 'high', acknowledged: true });
  assert.match(result.stdout, /synthetic session result/);
});
