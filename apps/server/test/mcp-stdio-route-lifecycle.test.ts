import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { and, eq } from "drizzle-orm";
import { decryptJson, encryptJson, globalRegistry } from "@zakura/core";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { signSession } from "../src/services/auth.js";

const tenantId = "tenant-stdio-route";

describe("stdio MCP install/update/remove route lifecycle", () => {
  let dir: string; let db: Db; let close: () => Promise<void>; let app: { request(input: string, init?: RequestInit): Promise<Response> }; let token: string;
  const children = new Map<string, ChildProcess>(); let starts = 0; let stops = 0;
  before(async () => {
    process.env.REDIS_URL = "off"; dir = mkdtempSync(join(tmpdir(), "zakura-stdio-route-"));
    const script = join(dir, "fake-mcp.mjs");
    writeFileSync(script, `const mode=process.argv[2];if(mode==='fail')process.exit(23);if(mode==='ready'){console.log('READY');setInterval(()=>{},1000)}setInterval(()=>{},1000)`);
    const databaseUrl = `pglite:${join(dir, "db")}`; await (await import("../src/db/migrate.js")).runMigrations(databaseUrl);
    const created = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir: dir }); db=created.db; close=created.close;
    const schema = await import("../src/db/schema.js"); const userId=schema.newId();
    await db.insert(schema.tenants).values({id:tenantId,name:"Stdio",slug:"stdio"}); await db.insert(schema.users).values({id:userId,email:"stdio@example.test"}); await db.insert(schema.tenantMemberships).values({tenantId,userId,role:"owner",status:"active"});
    const config={dataDir:dir,databaseUrl,secret:"stdio-secret",publicBaseUrl:"http://localhost",internalBaseUrl:"http://localhost"} as AppConfig;
    if (!globalRegistry.has("stdio-mcp")) globalRegistry.register((await import("../src/providers/stdio-mcp.js")).createStdioMcpProvider);
    await db.insert(schema.providerCatalog).values({id:"stdio-mcp",name:"Stdio MCP",description:"",version:"1",category:"mcp",capabilities:"[]",configSchema:"{}",createdAt:new Date(),updatedAt:new Date()}).onConflictDoNothing();
    const load=async(id:string)=>db.query.componentInstances.findFirst({where:and(eq(schema.componentInstances.id,id),eq(schema.componentInstances.tenantId,tenantId))});
    const toHandle=async(_t:string,id:string)=>{const row=await load(id);if(!row)throw new Error("not found");return{id:row.id,tenantId:row.tenantId,providerId:row.providerId,name:row.name,slug:row.slug,config:decryptJson<Record<string,unknown>>(config.secret,row.configEnc),endpointUrl:row.endpointUrl,containers:{}}};
    const stop=async(_t:string,id:string)=>{const child=children.get(id);if(child){child.kill("SIGTERM");await new Promise<void>(r=>child.once("exit",()=>r()));children.delete(id);stops++}await db.update(schema.componentInstances).set({status:"stopped",updatedAt:new Date()}).where(eq(schema.componentInstances.id,id));};
    const start=async(_t:string,id:string)=>{const existing=children.get(id);if(existing)return toHandle(tenantId,id);const h=await toHandle(tenantId,id);const args=JSON.parse(String(h.config.args??"[]")) as string[];const child=spawn(String(h.config.command),args,{stdio:["ignore","pipe","pipe"]});starts++;children.set(id,child);
      try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("stdio startup timed out")),500);child.stdout!.setEncoding("utf8");child.stdout!.on("data",d=>{if(String(d).includes("READY")){clearTimeout(timer);resolve()}});child.once("exit",code=>{clearTimeout(timer);reject(new Error(`stdio exited ${code}`))});child.once("error",reject)});}catch(e){if(child.exitCode===null){child.kill("SIGKILL");await new Promise<void>(r=>child.once("exit",()=>r()))}children.delete(id);await db.update(schema.componentInstances).set({status:"error",lastError:String(e),updatedAt:new Date()}).where(eq(schema.componentInstances.id,id));throw e;}
      await db.update(schema.componentInstances).set({status:"running",endpointUrl:"http://fake/mcp",updatedAt:new Date()}).where(eq(schema.componentInstances.id,id));return toHandle(tenantId,id)};
    const orchestrator:any={setOnInstanceReady(){},setOnInstanceStopped(){},getLastReconcile(){return null},toHandle,startInstance:start,ensureStarted:start,stopInstance:stop,rebuildInstance:async(t:string,id:string)=>{await stop(t,id);return start(t,id)},createInstance:async(input:any)=>{const plugin=globalRegistry.get(input.providerId);const normalized=plugin.validateConfig?.(input.config)??input.config;const [row]=await db.insert(schema.componentInstances).values({id:schema.newId(),tenantId:input.tenantId,providerId:input.providerId,name:input.name,slug:input.slug,configEnc:encryptJson(config.secret,normalized),status:"stopped",createdAt:new Date(),updatedAt:new Date()}).returning();return row},updateInstanceConfig:async(_t:string,id:string,patch:any,opts?:any)=>{const row=await load(id);if(!row)throw new Error("not found");const current=decryptJson<Record<string,unknown>>(config.secret,row.configEnc);await db.update(schema.componentInstances).set({configEnc:encryptJson(config.secret,opts?.replace?patch:{...current,...patch}),updatedAt:new Date()}).where(eq(schema.componentInstances.id,id));return toHandle(tenantId,id)}};
    const {AgentService}=await import("../src/services/agents.js"); const agentService=new AgentService(db,{} as never,config);
    const {McpGateway}=await import("../src/services/mcp-gateway.js"); const {DockerRuntime}=await import("../src/runtime/docker.js"); const gateway=new McpGateway(db,orchestrator,new DockerRuntime());
    const {OauthService}=await import("../src/services/oauth.js"); const {CloudAgentSessionStore}=await import("../src/services/cloud-agent-session.js");
    app=await (await import("../src/api/routes.js")).createApiApp({db,config,agentService,orchestrator,gateway,runtime:{} as never,memoryStore:{} as never,memoryProviders:{} as never,toolCallStore:{} as never,oauth:new OauthService(db,config),cloudSessionStore:new CloudAgentSessionStore(db)}) as any;
    token=signSession(config.secret,{userId,tenantId,email:"stdio@example.test",role:"owner"});
    (globalThis as any).__fakeScript=script;
  });
  after(async()=>{for(const child of children.values())child.kill("SIGKILL");await close?.();rmSync(dir,{recursive:true,force:true})});
  const request=(path:string,method:string,body?:unknown)=>app.request(`http://local${path}`,{method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  it("installs, updates/rebuilds, removes and retries without leaking fake stdio processes",async()=>{
    const script=(globalThis as any).__fakeScript as string;
    const install=await request("/api/mcp/import-stdio","POST",{name:"Fake stdio",slug:"fake-stdio",command:process.execPath,args:[script,"ready"],packageManager:"binary",all:false,start:true});assert.equal(install.status,201,await install.clone().text());const payload=await install.json() as any;assert.equal(payload.started,true);const id=payload.instance.id;assert.equal(children.size,1);
    const duplicateStart=await request(`/api/instances/${id}/start`,"POST");assert.equal(duplicateStart.status,200);assert.equal(starts,1);
    const updated=await request(`/api/instances/${id}`,"PATCH",{config:{args:JSON.stringify([script,"ready"]),env:JSON.stringify({REVISION:"2"})}});assert.equal(updated.status,200,await updated.clone().text());
    const rebuilt=await request(`/api/instances/${id}/rebuild`,"POST");assert.equal(rebuilt.status,200,await rebuilt.clone().text());assert.equal(children.size,1);assert.equal(starts,2);assert.equal(stops,1);
    const removed=await request(`/api/instances/${id}`,"DELETE");assert.equal(removed.status,200);assert.equal(children.size,0);assert.equal(stops,2);
    const retry=await request(`/api/instances/${id}`,"DELETE");assert.equal(retry.status,404);assert.equal(children.size,0);
  });
  it("cleans failed and timed-out fake stdio starts",async()=>{
    const script=(globalThis as any).__fakeScript as string;
    for(const mode of ["fail","timeout"]){const res=await request("/api/mcp/import-stdio","POST",{name:`Fake ${mode}`,slug:`fake-${mode}`,command:process.execPath,args:[script,mode],packageManager:"binary",all:false,start:true});assert.equal(res.status,201,await res.clone().text());const json=await res.json() as any;assert.equal(json.started,false);assert.match(json.startError,mode==="fail"?/exited 23/:/timed out/);assert.equal(children.size,0)}
  });
});
