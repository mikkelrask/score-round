import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { buildLobby } from '../lobby.js';
import { personalStats } from '../personal-stats.js';
import { normalizeFighter, matchFighter } from '../fighter-data.js';
import { getFighter } from '../functions/api/_fighters.js';
import { onRequestGet as statsGet } from '../functions/api/stats.js';
import { freshState } from '../data.js';
const now=Date.parse('2026-10-02T14:00:00Z');
const r=winner=>({winner,kd:{red:0,blue:0},ded:{red:0,blue:0}});
const card=(extra={})=>({id:'card',red:{name:'A Boxer'},blue:{name:'B Boxer'},weightClass:'Heavyweight',roundsTotal:3,roundLen:180,
  status:'done',rounds:[r('red'),r('red'),r('even')],startedAt:'2026-10-02T12:00:00Z',endedAt:'2026-10-02T12:15:00Z',draft:r('blue'),result:{type:'UD',winner:'red',note:'private note'},sourceFight:{provider:'boxing-data',id:'fight',eventId:'event',day:'2026-10-02',eventTitle:'Fight night',cornersConfirmed:false,redFighterId:'a',blueFighterId:'b'},...extra});
const official={available:true,id:'fight',rounds:3,fighters:[{id:'a',name:'A Boxer'},{id:'b',name:'B Boxer'}],scores:[[30,28]],pairing:'Test pairing'};
function database(){
  const sqlite=new DatabaseSync(':memory:');for(const f of ['0001_scorecards.sql','0002_fight_schedule.sql','0003_official_scores.sql','0005_fighter_profiles.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  return {prepare(sql){let args=[];const stmt={bind(...values){args=values;return stmt;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}};return stmt;}};
}
test('lobby groups compatible swapped corners, excludes stale/manual cards and never shares scores or progress',()=>{
 const active=card({status:'active'}),swapped={...active,id:'friend-card',red:active.blue,blue:active.red,sourceFight:{...active.sourceFight,redFighterId:'b',blueFighterId:'a'}};
 const rows=[{id:'me',email:'me@private.example',card:active},{id:'friend',email:'friend@private.example',card:swapped},{id:'stale',email:'stale@example.com',card:card({status:'active',startedAt:'2026-09-30T12:00:00Z'})},{id:'manual',email:'manual@example.com',card:{...active,sourceFight:null}}];
 const rooms=buildLobby(rows,'me',now);assert.equal(rooms.length,1);assert.equal(rooms[0].people.length,2);assert.equal(rooms[0].fight.roundLen,180);assert.equal(rooms[0].people.find(p=>p.you).name,'me');
 const serialized=JSON.stringify(rooms);for(const text of ['private note','draft','submitted','totals','@private.example','friend-card'])assert.equal(serialized.includes(text),false);
 assert.equal(buildLobby([...rows,{id:'other',email:'other@example.com',card:{...active,roundsTotal:12}}],'me',now).length,2);
});
test('stats distinguish incomplete cards, tied personal totals and entered draws; comparisons count each fight once',()=>{
 const full=card(),duplicate=card({id:'duplicate',endedAt:'2026-10-02T12:20:00Z'}),draw=card({id:'draw',sourceFight:null,rounds:[r('even'),r('even'),r('even')],result:{type:'Draw'}}),stop=card({id:'stop',sourceFight:null,rounds:[r('red')],result:{type:'KO'}}),incomplete=card({id:'incomplete',sourceFight:null,rounds:[r('red')],result:{type:'UD'}});
 const stats=personalStats([full,duplicate,draw,stop,incomplete],new Map([['fight',official]]));
 assert.equal(stats.fights,5);assert.equal(stats.rounds,11);assert.equal(stats.decisions,3);assert.equal(stats.closeCards,3);assert.equal(stats.levelCards,1);assert.equal(stats.recordedDraws,1);assert.equal(stats.stoppages,1);
 assert.equal(stats.rankedFights,1);assert.equal(stats.agreement,100);assert.equal(stats.trend[0].month,'2026-10');assert.equal(stats.trend[0].fights,1);
 assert.equal(personalStats([]).agreement,null);assert.equal(personalStats([]).averageMargin,null);
});
test('personal stats endpoint reads only owner history and never returns another user’s comparisons',async()=>{
 const DB=database();for(const id of ['me','friend']){await DB.prepare('INSERT INTO users (id,email,access_sub) VALUES (?,?,?)').bind(id,id+'@example.com',id).run();await DB.prepare('INSERT INTO scorecard_state (user_id,state_json) VALUES (?,?)').bind(id,JSON.stringify({...freshState(),history:id==='me'?[card()]:[card({id:'friend',red:{name:'Private Fighter'}})]})).run();}
 await DB.prepare('INSERT INTO official_fight_cache (id,payload_json) VALUES (?,?)').bind('fight',JSON.stringify(official)).run();
 const response=await statsGet({env:{DB},data:{user:{id:'me'}}});const data=await response.json();assert.equal(data.fights,1);assert.equal(data.agreement,100);assert.equal(JSON.stringify(data).includes('Private Fighter'),false);assert.equal(response.headers.get('Cache-Control'),'no-store');
});
const raw={id:'fighter',name:'A Boxer',birth_year:1988,height:'206 cm',nationality:'English',stance:'orthodox',stats:{wins:36,losses:2,draws:1,total_rounds:266},image:'unsafe',results:{winner:true}};
test('fighter normalizer preserves missing data, handles birth year without inventing age and rejects ambiguous names',()=>{
 const profile=normalizeFighter(raw);assert.equal(profile.age,null);assert.equal(profile.birthYear,1988);assert.equal(profile.knockouts,null);assert.deepEqual(profile.record,{wins:36,losses:2,draws:1});assert.equal(JSON.stringify(profile).includes('winner'),false);assert.equal(profile.image,undefined);
 assert.equal(matchFighter('A Boxer',[raw]).id,'fighter');assert.equal(matchFighter('A Boxer',[raw,{...raw,id:'different'}]),null);assert.equal(matchFighter('Boxer',[raw]),null);
});
test('fighter lookups cache across users, reject mismatched IDs and do not follow redirects with the API key',async()=>{
 const env={DB:database(),BOXING_RAPIDAPI_KEY:'test-key'};let calls=0;
 const fetcher=async(url,opts)=>{calls++;assert.equal(opts.redirect,'manual');assert.equal(new URL(url).hostname,'boxing-data-api.p.rapidapi.com');return Response.json({data:raw,error:{}});};
 const result=await getFighter(env,{id:'fighter'},{now:now/1000,fetcher});assert.equal(result.available,true);await getFighter(env,{id:'fighter'},{now:now/1000+1,fetcher});assert.equal(calls,1);
 const mismatch=await getFighter(env,{id:'wrong'},{now:now/1000,fetcher});assert.equal(mismatch.available,false);
 const redirect=await getFighter(env,{id:'redirect'},{now:now/1000,fetcher:async()=>new Response(null,{status:302,headers:{Location:'https://example.com'}})});assert.equal(redirect.available,false);
});
test('fighter budget and shared quota block upstream calls; failed refresh retains a marked stale profile',async()=>{
 const env={DB:database(),BOXING_RAPIDAPI_KEY:'test-key'};const time=now/1000;
 await getFighter(env,{id:'fighter'},{now:time,fetcher:async()=>Response.json({data:raw,error:{}})});
 const stale=await getFighter(env,{id:'fighter'},{now:time+86400*8,fetcher:async()=>{throw Error('Network error');}});assert.equal(stale.available,true);assert.equal(stale.stale,true);assert.equal(stale.fetchedAt,new Date(now).toISOString());
 await env.DB.prepare('UPDATE fighter_profile_usage SET requests=20').run();let calls=0;
 assert.equal((await getFighter(env,{id:'over-budget'},{now:time,fetcher:async()=>{calls++;}})).available,false);assert.equal(calls,0);
 await env.DB.prepare('UPDATE fighter_profile_usage SET requests=0').run();await env.DB.prepare('UPDATE fight_schedule_cache SET requests_remaining=0,quota_reset_at=?').bind(time+1000).run();
 assert.equal((await getFighter(env,{id:'quota'},{now:time,fetcher:async()=>{calls++;}})).available,false);assert.equal(calls,0);
});
test('concurrent profile requests atomically preserve ten known provider requests',async()=>{
 const env={DB:database(),BOXING_RAPIDAPI_KEY:'test-key'},time=now/1000;
 await env.DB.prepare('INSERT INTO fight_schedule_cache (id,requests_remaining,quota_reset_at) VALUES (?,?,?)').bind('boxing-data:7',11,time+1000).run();
 let calls=0;const fetcher=async url=>{calls++;const id=new URL(url).pathname.split('/').pop();return Response.json({data:{...raw,id},error:{}});};
 const results=await Promise.all([getFighter(env,{id:'first'},{now:time,fetcher}),getFighter(env,{id:'second'},{now:time,fetcher})]);
 assert.equal(calls,1);assert.equal(results.filter(r=>r.available).length,1);assert.equal((await env.DB.prepare('SELECT requests_remaining FROM fight_schedule_cache WHERE id=?').bind('boxing-data:7').first()).requests_remaining,10);
});
