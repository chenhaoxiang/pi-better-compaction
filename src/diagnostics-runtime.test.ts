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
