import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { freshState } from '../data.js';
import { buildFightNight, cornerOrder } from '../fight-night.js';
import { onRequestGet } from '../functions/api/fight-night.js';
const round = (winner='red', red=0, blue=0) => ({winner,kd:{red,blue},ded:{red:0,blue:0}});
const card = (extra={}) => ({id:'own',red:{name:'Red Boxer'},blue:{name:'Blue Boxer'},roundsTotal:3,roundLen:180,status:'active',rounds:[round()],draft:round('blue',9),weightClass:'',date:'2026-10-02T12:00:00Z',startedAt:'2026-10-02T12:00:00Z',endedAt:null,result:null,
  sourceFight:{provider:'boxing-data',id:'fight',redFighterId:'red-id',blueFighterId:'blue-id',day:'2026-10-02',eventTitle:'Test event',cornersConfirmed:true},...extra});
const user = (id, cards) => ({id,name:id,cards});
function database(){
  const sqlite=new DatabaseSync(':memory:');
  for(const file of ['0001_scorecards.sql','0003_official_scores.sql']) sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  return {prepare(sql){let args=[];const stmt={bind(...values){args=values;return stmt;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}};return stmt;}};
}
test('reveal truncates ahead cards and drafts, includes waiting friends and split votes',()=>{
  const own=card(), other=card({id:'other',rounds:[round('blue'),round('red'),round('even')],result:{note:'private note'}}), waiting=card({id:'waiting',rounds:[]});
  const data=buildFightNight(own,[user('me',[own]),user('friend',[other]),user('waiting',[waiting])],'me',1);
  assert.equal(data.throughRound,1);assert.equal(data.rounds[0].split,true);assert.deepEqual(data.rounds[0].votes,{red:1,blue:1,even:0});
  assert.equal(data.participants.find(p=>p.name==='friend').rounds.length,1);assert.deepEqual(data.participants[0].totals,{red:10,blue:9});
  assert.equal(data.participants.find(p=>p.name==='waiting').submitted,0);
  const json=JSON.stringify(data);for(const value of ['private note','red-id','draft','own','endedAt']) assert.equal(json.includes(value),false);
  assert.equal(data.official,null);
});
test('swapped corners map votes, knockdowns and totals using fighter IDs or exact names',()=>{
  const own=card(), swapped=card({id:'swapped',red:own.blue,blue:own.red,sourceFight:{...own.sourceFight,redFighterId:'blue-id',blueFighterId:'red-id'},rounds:[round('blue',1,0)]});
  assert.deepEqual(cornerOrder(own,swapped),['blue','red']);
  const result=buildFightNight(own,[user('me',[own]),user('other',[swapped])],'me',1);
  assert.deepEqual(result.participants[1].rounds[0],{winner:'red',red:10,blue:8});
  assert.deepEqual(cornerOrder(card({sourceFight:{provider:'boxing-data',id:'fight'}}),{...swapped,sourceFight:{provider:'boxing-data',id:'fight'}}),['blue','red']);
  assert.equal(cornerOrder(own,card({sourceFight:{...own.sourceFight,id:'different'}})),null);
  assert.equal(cornerOrder(own,card({roundsTotal:12})),null);
});
test('one card per user; current active card takes precedence and unrelated fighters are excluded',()=>{
  const own=card();const done=card({id:'done',status:'done',endedAt:'2026-10-02T12:01:00Z',rounds:[round('blue')]});
  const unrelated=card({red:{name:'Someone Else'},sourceFight:{...own.sourceFight,redFighterId:'else-id'}});
  const result=buildFightNight(own,[user('me',[own,done]),user('friend',[done,card({id:'active'})]),user('unrelated',[unrelated])],'me',1);
  assert.equal(result.participants.length,2);assert.equal(result.rounds[0].votes.red,2);
});
test('official totals are exposed only for a completed full-length decision card',()=>{
  const official={available:true,id:'fight',rounds:3,fighters:[{id:'red-id',name:'Red Boxer'},{id:'blue-id',name:'Blue Boxer'}],scores:[[30,27]],pairing:'Test pairing'};
  const own=card({rounds:[round(),round(),round()]});
  assert.equal(buildFightNight(own,[user('me',[own])],'me',3,official).official,null);
  const done={...own,status:'done',result:{type:'UD'}};
  assert.equal(buildFightNight(done,[user('me',[done])],'me',2,official).official,null);
  assert.equal(buildFightNight({...done,result:{type:'KO'}},[user('me',[done])],'me',3,official).official,null);
  assert.deepEqual(buildFightNight(done,[user('me',[done])],'me',3,official).official.scores,[{red:30,blue:27}]);
});
test('endpoint verifies card ownership and committed-round gate before reading the room',async()=>{
  const DB=database(), env={DB};
  for(const id of ['me','friend']) {
    await DB.prepare('INSERT INTO users (id,email,access_sub) VALUES (?,?,?)').bind(id,id+'@private.example',id).run();
    await DB.prepare('INSERT INTO scorecard_state (user_id,state_json) VALUES (?,?)').bind(id,JSON.stringify({...freshState(),active:card({id,rounds:id==='friend'?[round('blue'),round('blue')]:[round()]})})).run();
  }
  const get=async(id,roundNo)=>onRequestGet({env,data:{user:{id:'me',email:'me@private.example'}},request:new Request(`https://boxing-round.pages.dev/api/fight-night?card=${id}&round=${roundNo}`)});
  assert.equal((await get('friend',1)).status,404);assert.equal((await get('me',2)).status,403);assert.equal((await get('me',25)).status,400);
  const response=await get('me',1);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const result=await response.json();assert.equal(result.participants.length,2);assert.equal(result.participants.find(p=>p.name==='friend').submitted,1);
  assert.equal(JSON.stringify(result).includes('@private.example'),false);
  // Removing the owner's saved round closes the gate, even for a previously revealed round.
  await DB.prepare('UPDATE scorecard_state SET state_json=? WHERE user_id=?').bind(JSON.stringify({...freshState(),active:card({id:'me',rounds:[]})}),'me').run();
  assert.equal((await get('me',1)).status,403);
});
