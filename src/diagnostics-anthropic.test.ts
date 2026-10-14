import {expect,test} from 'bun:test';
import {registerExtensionRuntime} from './extension-runtime';
import {DEFAULT_EXTENSION_CONFIG} from './types';
for(const reason of ['request-failed','invalid-response'] as const)test(`Anthropic wrapper retains ${reason} without private errors`,async()=>{
 const hooks=new Map<string,any>();let command:any;const notices:string[]=[];
 registerExtensionRuntime({on:(n:string,f:any)=>hooks.set(n,f),registerCommand:(_n:string,c:any)=>command=c} as never,{
  loadExtensionConfig:()=>({config:DEFAULT_EXTENSION_CONFIG,warnings:[]}),
  executeAnthropicCompaction:async()=>({ok:false,reason,errorMessage:'never-display-in-status'}),
  runNativeFallbackCompaction:async()=>({ok:false,reason:'no-model-configured'}),
 } as never);
 const ctx={model:{provider:'fixture',api:'anthropic-messages',id:'claude-synthetic',baseUrl:'https://example.invalid/v1'},hasUI:true,ui:{notify:(m:string)=>notices.push(m),setStatus(){}},getSystemPrompt:()=>'',sessionManager:{getBranch:()=>[],getSessionId:()=> 'synthetic'},modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true,apiKey:'synthetic-not-real'}),getAll:()=>[],find:()=>undefined}};
 await hooks.get('session_before_compact')({preparation:{tokensBefore:100,firstKeptEntryId:'keep',messagesToSummarize:[],turnPrefixMessages:[]},signal:new AbortController().signal},ctx);
 notices.length=0;await command.handler('',ctx);expect(notices[0]).toContain(`Anthropic: failed (${reason})`);expect(notices[0]).not.toContain('never-display-in-status');
});
