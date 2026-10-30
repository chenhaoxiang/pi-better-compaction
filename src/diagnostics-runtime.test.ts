import { expect, test } from "bun:test";
import { registerExtensionRuntime } from "./extension-runtime";
import { reconstructPortableHistory } from "./portable-history";
import { createNativeCompactionDetails, DEFAULT_EXTENSION_CONFIG, NATIVE_COMPACTION_FALLBACK_SUMMARY } from "./types";
const stamp="2026-10-14T00:00:00.000Z";
const msg=(id:string,parentId:string|null)=>({type:"message",id,parentId,timestamp:stamp,message:{role:"user",content:[{type:"text",text:id}],timestamp:1}});
const checkpoint={type:"compaction",id:"checkpoint",parentId:"kept",timestamp:stamp,firstKeptEntryId:"kept",summary:NATIVE_COMPACTION_FALLBACK_SUMMARY,tokensBefore:1000,details:createNativeCompactionDetails({provider:"mock",api:"openai-responses",model:"mock",baseUrl:"https://example.invalid/v1",compactedWindow:[{type:"compaction",encrypted_content:"private-blob"}]})};

test("runtime command computes none/invalid/uncached/cached from the current branch without auth", async () => {
  const hooks=new Map<string,any>();let command:any;let branch:any[]=[];const notices:string[]=[];
  registerExtensionRuntime({on:(n:string,f:any)=>hooks.set(n,f),registerCommand:(_n:string,c:any)=>{command=c}} as never, {loadExtensionConfig:()=>({config:DEFAULT_EXTENSION_CONFIG,warnings:[]})} as never);
  const ctx={hasUI:true,modelRegistry:{getApiKeyAndHeaders:()=>{throw new Error("never call auth")}},ui:{notify:(m:string)=>notices.push(m)},sessionManager:{getBranch:()=>branch,getSessionId:()=>"synthetic",getSessionFile:()=>undefined},cwd:"/synthetic"};
  await command.handler("",ctx);expect(notices.at(-1)).toContain("not-required-for-text");
  branch=[{...checkpoint,details:null}];await command.handler("",ctx);expect(notices.at(-1)).toContain("invalid-checkpoint");
  branch=[msg("old",null),msg("kept","old"),checkpoint];await command.handler("",ctx);expect(notices.at(-1)).toContain("preparation-required-on-incompatible-request");
  const source=reconstructPortableHistory(branch as never,checkpoint as never);expect(source.ok).toBe(true);
  if(!source.ok)throw new Error("fixture history invalid");
  branch.push({type:"custom",id:"portable",parentId:"checkpoint",timestamp:stamp,customType:"pi-better-compaction-portable-summary",data:{compactionEntryId:"checkpoint",sourceDigest:source.sourceDigest,summary:"never display"}});
  await command.handler("",ctx);expect(notices.at(-1)).toContain("cached-for-current-history");expect(notices.at(-1)).not.toContain("private-blob");expect(notices.at(-1)).not.toContain("never display");
  hooks.get("session_tree")();hooks.get("session_start")({},ctx);
});

test("blocked native replay remains inspectable without enabling payload logs or making a diagnostic request", async () => {
  const hooks=new Map<string,any>();let command:any;const notices:string[]=[];
  const branch=[msg("old",null),msg("kept","old"),checkpoint,msg("tail","checkpoint")];
  let authCalls=0;let aborted=0;
  registerExtensionRuntime({on:(n:string,f:any)=>hooks.set(n,f),registerCommand:(_n:string,c:any)=>{command=c}} as never,
    {loadExtensionConfig:()=>({config:DEFAULT_EXTENSION_CONFIG,warnings:[]})} as never);
  const ctx={hasUI:true,cwd:"/synthetic",signal:new AbortController().signal,
    model:{provider:"mock",api:"openai-responses",id:"mock",baseUrl:"https://example.invalid/v1",input:["text"],reasoning:false},
    modelRegistry:{getApiKeyAndHeaders:async()=>{authCalls++;return {ok:true,apiKey:"synthetic"}}},
    ui:{notify:(m:string)=>notices.push(m)},abort:()=>{aborted++},
    sessionManager:{getBranch:()=>branch,getSessionId:()=>"synthetic",getSessionFile:()=>undefined}};
  await hooks.get("before_provider_request")({payload:{model:"mock",input:[{role:"user",content:"private-request-content"}]}},ctx);
  expect(aborted).toBe(1);
  const authBeforeStatus=authCalls;
  await command.handler("",ctx);
  expect(authCalls).toBe(authBeforeStatus);
  expect(notices.at(-1)).toContain("Native replay guard: failed (expected-pi-replay-mismatch)");
  expect(notices.at(-1)).not.toContain("private-request-content");
  expect(notices.at(-1)).not.toContain("private-blob");
  hooks.get("session_tree")();
  await command.handler("",ctx);
  expect(notices.at(-1)).not.toContain("Native replay guard:");
});
