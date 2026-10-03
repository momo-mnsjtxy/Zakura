import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { createUserSession, verifySession } from "../src/services/auth.js";
import { IdentitySessionService } from "../src/services/identity/sessions.js";
import { invalidateUserSuspension } from "../src/services/account-status.js";

const tenantId = "tenant-identity-routes";
describe("identity session lifecycle routes", () => {
  let dir:string, db:Db, close:()=>Promise<void>, config:AppConfig, app:{request(input:string,init?:RequestInit):Promise<Response>};
  let passwordUserId:string, oauthUserId:string;
  before(async()=>{
    process.env.REDIS_URL="off";dir=mkdtempSync(join(tmpdir(),"zakura-identity-session-"));const databaseUrl=`pglite:${join(dir,"db")}`;
    await (await import("../src/db/migrate.js")).runMigrations(databaseUrl);const created=await (await import("../src/db/client.js")).createDb({databaseUrl,dataDir:dir});db=created.db;close=created.close;
    const s=await import("../src/db/schema.js");passwordUserId=s.newId();oauthUserId=s.newId();
    await db.insert(s.tenants).values({id:tenantId,name:"Identity",slug:"identity"});
    await db.insert(s.users).values([{id:passwordUserId,email:"password@example.test",passwordHash:await bcrypt.hash("password-123",4)},{id:oauthUserId,email:"oauth@example.test",passwordHash:null}]);
    await db.insert(s.tenantMemberships).values([{tenantId,userId:passwordUserId,role:"owner",status:"active"},{tenantId,userId:oauthUserId,role:"member",status:"active"}]);
    config={dataDir:dir,databaseUrl,secret:"identity-secret",publicBaseUrl:"http://localhost",internalBaseUrl:"http://localhost"} as AppConfig;
    const orchestrator:any={setOnInstanceReady(){},setOnInstanceStopped(){},getLastReconcile(){return null}};
    const {AgentService}=await import("../src/services/agents.js");const agentService=new AgentService(db,{} as never,config);
    const {McpGateway}=await import("../src/services/mcp-gateway.js");const {DockerRuntime}=await import("../src/runtime/docker.js");const gateway=new McpGateway(db,orchestrator,new DockerRuntime());
    const {OauthService}=await import("../src/services/oauth.js");const {CloudAgentSessionStore}=await import("../src/services/cloud-agent-session.js");
    app=await (await import("../src/api/routes.js")).createApiApp({db,config,agentService,orchestrator,gateway,runtime:{} as never,memoryStore:{} as never,memoryProviders:{} as never,toolCallStore:{} as never,oauth:new OauthService(db,config),cloudSessionStore:new CloudAgentSessionStore(db)}) as any;
  });
  after(async()=>{await close?.();rmSync(dir,{recursive:true,force:true})});
  const get=(token:string,path="/api/me")=>app.request(`http://local${path}`,{headers:{authorization:`Bearer ${token}`}});
  const issue=(userId:string,email:string,role="member",ttl=3600)=>createUserSession(db,config.secret,{userId,tenantId,email,role},undefined,ttl);

  it("keeps password and OAuth-only identities on the same durable session contract",async()=>{
    for(const [id,email,role] of [[passwordUserId,"password@example.test","owner"],[oauthUserId,"oauth@example.test","member"]] as const){const token=await issue(id,email,role);const response=await get(token);assert.equal(response.status,200,await response.clone().text());assert.equal(((await response.json()) as any).user.email,email)}
  });
  it("rejects stale, revoked and cross-tenant session rows",async()=>{
    const expired=await issue(passwordUserId,"password@example.test","owner",-1);assert.equal((await get(expired)).status,401);
    const token=await issue(passwordUserId,"password@example.test","owner");const payload=verifySession(config.secret,token)!;assert.equal(await new IdentitySessionService(db).revoke(passwordUserId,payload.sid!),true);assert.equal((await get(token)).status,401);
    const forged=await createUserSession(db,config.secret,{userId:passwordUserId,tenantId,email:"password@example.test",role:"owner"});const fp=verifySession(config.secret,forged)!;
    const {signSession}=await import("../src/services/auth.js");const cross=signSession(config.secret,{...fp,tenantId:"another-tenant"});assert.equal((await get(cross)).status,401);
  });
  it("returns suspension semantics with timestamp-backed state",async()=>{
    const token=await issue(passwordUserId,"password@example.test","owner");const {users}=await import("../src/db/schema.js");const at=new Date();await db.update(users).set({suspendedAt:at,suspendedReason:"policy"}).where(eq(users.id,passwordUserId));invalidateUserSuspension(passwordUserId);
    const response=await get(token);assert.equal(response.status,403);const body=await response.json() as any;assert.equal(body.code,"account_suspended");assert.match(body.error,/policy/);
    const lookup=await new IdentitySessionService(db).lookup(verifySession(config.secret,token)!);assert.equal(lookup.status,"suspended");if(lookup.status==="suspended")assert.equal(lookup.suspendedAt.getTime(),at.getTime());
    await db.update(users).set({suspendedAt:null,suspendedReason:null}).where(eq(users.id,passwordUserId));invalidateUserSuspension(passwordUserId);
  });
  it("makes concurrent revoke idempotent and revoke-others atomic",async()=>{
    const token=await issue(passwordUserId,"password@example.test","owner");const sid=verifySession(config.secret,token)!.sid!;const service=new IdentitySessionService(db);const results=await Promise.all([service.revoke(passwordUserId,sid),service.revoke(passwordUserId,sid)]);assert.deepEqual(results.sort(),[false,true]);
    const current=await issue(passwordUserId,"password@example.test","owner");const currentSid=verifySession(config.secret,current)!.sid!;await Promise.all([issue(passwordUserId,"password@example.test","owner"),issue(passwordUserId,"password@example.test","owner")]);const counts=await Promise.all([service.revokeOthers(passwordUserId,currentSid),service.revokeOthers(passwordUserId,currentSid)]);assert.ok(counts[0]+counts[1]>=2);assert.equal((await get(current)).status,200);
  });
  it("atomically redeems verification and reset links through real public routes",async()=>{
    const { issueAuthToken } = await import("../src/services/identity/tokens.js");
    const expired=await issueAuthToken(db,{kind:"email_verify",userId:oauthUserId,ttlMs:-1});
    assert.equal((await app.request("http://local/api/auth/verify-email",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:expired})})).status,400);
    const schema=await import("../src/db/schema.js");await db.update(schema.users).set({suspendedAt:new Date(),suspendedReason:"blocked"}).where(eq(schema.users.id,oauthUserId));const blocked=await issueAuthToken(db,{kind:"password_reset",userId:oauthUserId});assert.equal((await app.request("http://local/api/auth/reset-password",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:blocked,password:"new-password-123"})})).status,400);await db.update(schema.users).set({suspendedAt:null,suspendedReason:null}).where(eq(schema.users.id,oauthUserId));
    const verify=await issueAuthToken(db,{kind:"email_verify",userId:oauthUserId});const verifyReq=()=>app.request("http://local/api/auth/verify-email",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:verify})});
    const verified=await Promise.all([verifyReq(),verifyReq()]);assert.deepEqual(verified.map(r=>r.status).sort(),[200,400]);
    const oldSession=await issue(passwordUserId,"password@example.test","owner");const reset=await issueAuthToken(db,{kind:"password_reset",userId:passwordUserId});const resetReq=()=>app.request("http://local/api/auth/reset-password",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:reset,password:"new-password-123"})});
    const resetResults=await Promise.all([resetReq(),resetReq()]);assert.deepEqual(resetResults.map(r=>r.status).sort(),[200,400]);assert.equal((await get(oldSession)).status,401);
  });
  it("uses deterministic mail delivery boundaries without changing route payloads",async()=>{
    const { requestEmailVerification, requestPasswordReset }=await import("../src/services/identity/account.js");const sent:Array<{to:string,url:string}>=[];const send=async(to:string,url:string)=>{sent.push({to,url});return true};
    const {users}=await import("../src/db/schema.js");await db.update(users).set({emailVerifiedAt:null}).where(eq(users.id,oauthUserId));assert.equal(await requestEmailVerification(db,"https://web.example",{id:oauthUserId,email:"oauth@example.test",emailVerifiedAt:null},send),true);
    await requestPasswordReset(db,"https://web.example","password@example.test",send);assert.equal(sent.length,2);assert.match(sent[0]!.url,/verify-email\?token=atk_/);assert.match(sent[1]!.url,/reset-password\?token=atk_/);
  });
  it("prevents MFA ticket/recovery reuse and rejects revoked principals before consuming recovery",async()=>{
    const schema=await import("../src/db/schema.js");const {hashToken}=await import("../src/services/identity/util.js");const {issueAuthToken}=await import("../src/services/identity/tokens.js");const code="abcde-12345";
    await db.insert(schema.userRecoveryCodes).values({id:schema.newId(),userId:oauthUserId,codeHash:hashToken("abcde12345"),createdAt:new Date()});const ticket=await issueAuthToken(db,{kind:"mfa_login",userId:oauthUserId,meta:{tenantId,role:"member"}});const complete=(t:string)=>app.request("http://local/api/auth/mfa/complete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticket:t,recoveryCode:code})});
    const raced=await Promise.all([complete(ticket),complete(ticket)]);assert.deepEqual(raced.map(r=>r.status).sort(),[200,400]);const reused=await issueAuthToken(db,{kind:"mfa_login",userId:oauthUserId,meta:{tenantId,role:"member"}});assert.equal((await complete(reused)).status,401);
    const freshCode="fffff-11111";await db.insert(schema.userRecoveryCodes).values({id:schema.newId(),userId:oauthUserId,codeHash:hashToken("fffff11111"),createdAt:new Date()});await db.update(schema.tenantMemberships).set({status:"suspended"}).where(eq(schema.tenantMemberships.userId,oauthUserId));const revoked=await issueAuthToken(db,{kind:"mfa_login",userId:oauthUserId,meta:{tenantId,role:"member"}});const denied=await app.request("http://local/api/auth/mfa/complete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticket:revoked,recoveryCode:freshCode})});assert.equal(denied.status,400);
    const recovery=await db.query.userRecoveryCodes.findFirst({where:eq(schema.userRecoveryCodes.codeHash,hashToken("fffff11111"))});assert.equal(recovery?.usedAt,null);await db.update(schema.tenantMemberships).set({status:"active"}).where(eq(schema.tenantMemberships.userId,oauthUserId));
  });
  it("claims invitations once under concurrent redemption",async()=>{
    const schema=await import("../src/db/schema.js");const invitedId=schema.newId();await db.insert(schema.users).values({id:invitedId,email:"invited@example.test",passwordHash:null});const {TenantService}=await import("../src/services/tenants.js");const service=new TenantService(db);const expired=await service.createInvite({tenantId,email:"expired@example.test",role:"member",invitedByUserId:passwordUserId,ttlHours:-1});await assert.rejects(()=>service.acceptInvite({token:expired.token,email:"expired@example.test",password:"password-123"}),/expired/i);const made=await service.createInvite({tenantId,email:"invited@example.test",role:"member",invitedByUserId:passwordUserId});const redeem=()=>service.acceptInvite({token:made.token,userId:invitedId});const outcomes=await Promise.allSettled([redeem(),redeem()]);assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1);assert.equal(outcomes.filter(x=>x.status==="rejected").length,1);const memberships=await db.query.tenantMemberships.findMany({where:eq(schema.tenantMemberships.userId,invitedId)});assert.equal(memberships.length,1);
  });

  it("enforces optional, admins and all tenant MFA policies on the real login route",async()=>{
    const schema=await import("../src/db/schema.js");
    const {setTenantMfaPolicy}=await import("../src/services/identity/mfa.js");
    const password="mfa-policy-password";const passwordHash=await bcrypt.hash(password,4);
    const rows=[
      {id:schema.newId(),email:"mfa-owner@example.test",role:"owner"},
      {id:schema.newId(),email:"mfa-admin@example.test",role:"admin"},
      {id:schema.newId(),email:"mfa-member@example.test",role:"member"},
      {id:schema.newId(),email:"mfa-enrolled@example.test",role:"admin"},
    ] as const;
    await db.insert(schema.users).values(rows.map((row)=>({id:row.id,email:row.email,passwordHash})));
    await db.insert(schema.tenantMemberships).values(rows.map((row)=>({id:schema.newId(),tenantId,userId:row.id,role:row.role,status:"active"})));
    await db.insert(schema.userWebauthnCredentials).values({
      id:schema.newId(),userId:rows[3].id,credentialId:`cred-${schema.newId()}`,
      publicKey:"AA",counter:0,name:"Policy passkey",transportsJson:"[]",createdAt:new Date(),
    });
    const login=(email:string)=>app.request("http://local/api/auth/login",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({email,password,tenantSlug:"identity"}),
    });
    await setTenantMfaPolicy(db,tenantId,"optional");assert.equal((await login(rows[0].email)).status,200);
    await setTenantMfaPolicy(db,tenantId,"admins");
    for(const row of rows.slice(0,2)){const response=await login(row.email);assert.equal(response.status,200);const body=await response.json() as {code?:string;mfaEnrollmentTicket?:string};assert.equal(body.code,"mfa_enrollment_required");assert.ok(body.mfaEnrollmentTicket)}
    assert.equal((await login(rows[2].email)).status,200);
    const enrolled=await login(rows[3].email);assert.equal(enrolled.status,200);const enrolledBody=await enrolled.json() as {mfaRequired?:boolean;methods?:string[]};assert.equal(enrolledBody.mfaRequired,true);assert.deepEqual(enrolledBody.methods,["webauthn"]);
    await setTenantMfaPolicy(db,tenantId,"all");const allDenied=await login(rows[2].email);assert.equal(allDenied.status,200);const allBody=await allDenied.json() as {code?:string;mfaEnrollmentTicket?:string};assert.equal(allBody.code,"mfa_enrollment_required");assert.ok(allBody.mfaEnrollmentTicket);
    await setTenantMfaPolicy(db,tenantId,"optional");
  });

  it("enrolls required MFA with a tenant-bound one-time ticket",async()=>{
    const schema=await import("../src/db/schema.js");const {issueAuthToken}=await import("../src/services/identity/tokens.js");const {setTenantMfaPolicy}=await import("../src/services/identity/mfa.js");const {Secret,TOTP}=await import("otpauth");
    const userId=schema.newId();await db.insert(schema.users).values({id:userId,email:"mfa-enrollment@example.test",passwordHash:await bcrypt.hash("password-123",4)});await db.insert(schema.tenantMemberships).values({id:schema.newId(),tenantId,userId,role:"member",status:"active"});await setTenantMfaPolicy(db,tenantId,"all");
    const ticket=await issueAuthToken(db,{kind:"mfa_enrollment",userId,meta:{tenantId,role:"member"}});
    const start=await app.request("http://local/api/auth/mfa/enrollment/totp/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticket})});assert.equal(start.status,200,await start.clone().text());const setup=await start.json() as {secret:string};
    const wrong=await app.request("http://local/api/auth/mfa/enrollment/totp/complete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticket,code:"000000"})});assert.equal(wrong.status,400);
    const code=new TOTP({issuer:"Zakura",label:"user",algorithm:"SHA1",digits:6,period:30,secret:Secret.fromBase32(setup.secret)}).generate();
    const complete=()=>app.request("http://local/api/auth/mfa/enrollment/totp/complete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticket,code})});const raced=await Promise.all([complete(),complete()]);assert.deepEqual(raced.map((response)=>response.status).sort(),[200,400]);const success=raced.find((response)=>response.status===200)!;const successBody=await success.json() as {session?:string;recoveryCodes?:string[]};assert.ok(successBody.session);assert.equal(successBody.recoveryCodes?.length,8);assert.equal((await complete()).status,400);
    const expired=await issueAuthToken(db,{kind:"mfa_enrollment",userId,meta:{tenantId,role:"member"},ttlMs:-1});const expiredStart=await app.request("http://local/api/auth/mfa/enrollment/totp/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticket:expired})});assert.equal(expiredStart.status,400);
    const foreign=await issueAuthToken(db,{kind:"mfa_enrollment",userId,meta:{tenantId:"foreign-tenant",role:"member"}});const foreignStart=await app.request("http://local/api/auth/mfa/enrollment/totp/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticket:foreign})});assert.equal(foreignStart.status,400);
    await setTenantMfaPolicy(db,tenantId,"optional");
  });

});
