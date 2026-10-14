import { expect, test } from "bun:test";
import { checkpointSnapshot, registerCompactionDiagnostics, usageSnapshot } from "./diagnostics";
import { createNativeCompactionDetails, NATIVE_COMPACTION_FALLBACK_SUMMARY } from "./types";
const make = (x: unknown) => x as never;
const details = createNativeCompactionDetails({ provider: "synthetic", api: "openai-responses", model: "synthetic", baseUrl: "https://example.invalid/v1", compactedWindow: [{ type: "compaction", encrypted_content: "never-display" }] });

test("checkpoint states never expose opaque blob or summary content", () => {
  expect(checkpointSnapshot([])).toBe("none");
  expect(checkpointSnapshot(make([{type:"compaction",id:"a",summary:"private text"}]))).toBe("text-summary");
  expect(checkpointSnapshot(make([{type:"compaction",id:"a",summary:NATIVE_COMPACTION_FALLBACK_SUMMARY}]))).toBe("invalid-opaque-checkpoint");
  expect(checkpointSnapshot(make([{type:"compaction",id:"a",summary:NATIVE_COMPACTION_FALLBACK_SUMMARY,details}]))).toBe("openai-opaque-checkpoint");
  expect(checkpointSnapshot(make([{type:"compaction",id:"a",summary:"readable",details}]))).toBe("native-readable-summary");
  expect(checkpointSnapshot(make([{type:"compaction",id:"a",summary:"readable",details:{...details,strategy:"anthropic-native-compact-v1"}}]))).toBe("anthropic-readable-summary-and-block");
});
test("persisted accounting and lazy usage remain separate, duplicates do not double count", () => {
  const a={type:"compaction",id:"a",usage:{input:10,output:2,totalTokens:12,cacheRead:0,cacheWrite:0},details:{usageRecords:[{usage:{totalTokens:12}}]}};
  const b={type:"custom",id:"b",customType:"pi-better-compaction-portable-summary",data:{summary:"never output",usageRecords:[{provider:"private",usage:{input:3,output:4,totalTokens:7}}]}};
  const c={...b,id:"c",customType:"pi-better-compaction-portable-usage"};
  const result=usageSnapshot(make([a,a,b,c,{id:"ignored",type:"message"}]));
  expect(result.compaction.totalTokens).toBe(12);expect(result.portable.totalTokens).toBe(14);
  expect(result.compactionRecords).toBe(1);expect(result.portableRecords).toBe(2);expect(result.portable.cacheRead).toBeNull();
});
test("absent, malformed, invalid and overflow usage is not fabricated", () => {
  const branch=[{type:"compaction",id:"a"},{type:"custom",id:"b",customType:"pi-better-compaction-portable-summary",data:null},{type:"custom",id:"c",customType:"pi-better-compaction-portable-usage",data:{usageRecords:[{}, {usage:{input:-1,output:NaN,totalTokens:Infinity}},null]}}];
  const result=usageSnapshot(make(branch));expect(result.missing).toBe(5);expect(result.compaction.totalTokens).toBeNull();expect(result.portable.totalTokens).toBeNull();
  expect(usageSnapshot(make([{type:"compaction",id:"1",usage:{totalTokens:Number.MAX_SAFE_INTEGER}},{type:"compaction",id:"2",usage:{totalTokens:1}}])).compaction.totalTokens).toBe(Number.MAX_SAFE_INTEGER);
});
function commandHarness(opts: {hasUI?:boolean;throwRead?:boolean; attempts?:any[]}={}) {
  let command:any;const notices:string[]=[];let reads=0,ports=0;
  registerCompactionDiagnostics(make({registerCommand:(_n:string,c:any)=>{command=c}}),{attempts:()=>opts.attempts??[],portableState:()=>"preparation-required-on-incompatible-request"});
  const ctx={hasUI:opts.hasUI??true,ui:{notify:(m:string)=>notices.push(m)},sessionManager:{getBranch:()=>{reads++;if(opts.throwRead)throw new Error("secret-path");return []}},modelRegistry:{getApiKeyAndHeaders:()=>{ports++}},abort:()=>{ports++}};
  return {command,ctx,notices,get reads(){return reads},get ports(){return ports}};
}
test("command is readonly, no auth/model/session mutation, and absent cost stays unknown", async () => {
  const h=commandHarness({attempts:[{method:"Responses v2",outcome:"failed",reason:"network-error"},{method:"Text fallback",outcome:"response-ok"}]});
  await h.command.handler("",h.ctx);expect(h.notices[0]).toContain("network-error");expect(h.notices[0]).toContain("not checkpoint persistence");expect(h.notices[0]).toContain("unpriced/unknown");expect(h.ports).toBe(0);
  await h.command.handler("usage",h.ctx);expect(h.notices[1]).not.toContain("Checkpoint:");expect(h.reads).toBe(2);
});
test("no runtime history, non-UI, invalid args and unavailable branch stay honest", async () => {
  const normal=commandHarness();await normal.command.handler("",normal.ctx);expect(normal.notices[0]).toContain("No compaction attempts");
  const noUI=commandHarness({hasUI:false});await noUI.command.handler("",noUI.ctx);expect(noUI.reads).toBe(0);
  const invalid=commandHarness();await invalid.command.handler("erase",invalid.ctx);expect(invalid.reads).toBe(0);expect(invalid.notices[0]).toContain("Usage:");
  const bad=commandHarness({throwRead:true});await bad.command.handler("",bad.ctx);expect(bad.notices[0]).not.toContain("secret-path");expect(bad.ports).toBe(0);
});
