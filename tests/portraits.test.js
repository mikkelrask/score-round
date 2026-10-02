import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { matchBoxer, commonsPortrait, safeImageUrl, initials } from '../portrait-data.js';
import { getPortrait, getPortraitImage, portraitKey } from '../functions/api/_portraits.js';
const claim = value => ({ mainsnak: { datavalue: { value } } });
const boxer = { id: 'Q1', labels: { en: { value: 'Test Boxer' } }, claims: { P31: [claim({ id: 'Q5' })], P106: [claim({ id: 'Q11338576' })], P18: [claim('Photo.jpg')] } };
const info = { thumburl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Photo.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Photo.jpg', mime: 'image/jpeg', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' }, Artist: { value: '<a>Photographer</a>' }, Attribution: { value: 'Photographer / WikiPortraits' } } };
function database() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync(new URL('../migrations/0004_fighter_portraits.sql', import.meta.url), 'utf8'));
  return { prepare(sql) { let args=[]; const statement={ bind(...values){args=values;return statement;}, async first(){return sqlite.prepare(sql).get(...args)||null;}, async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};} };return statement;} };
}
test('only a unique human boxer with an exact name receives a portrait', () => {
  assert.deepEqual(matchBoxer('Test Boxer', {Q1:boxer}), {id:'Q1',file:'Photo.jpg'});
  assert.equal(matchBoxer('Test', {Q1:boxer}), null);
  assert.equal(matchBoxer('Test Boxer', {Q1:boxer,Q2:{...boxer,id:'Q2'}}),null);
  assert.equal(matchBoxer('Test Boxer', {Q1:{...boxer,claims:{...boxer.claims,P106:[]}}}),null);
  assert.equal(initials('Oleksandr Usyk'),'OU');
});
test('credits preserve required attribution and reject mismatched licenses and foreign image hosts', () => {
  assert.equal(commonsPortrait(info,'Photo.jpg','Q1').author,'Photographer / WikiPortraits');
  assert.equal(commonsPortrait({...info,extmetadata:{...info.extmetadata,LicenseUrl:{value:'https://creativecommons.org/licenses/by/4.0/'}}},'Photo.jpg','Q1'),null);
  for(const url of ['https://example.com/wikipedia/commons/a.jpg','http://upload.wikimedia.org/wikipedia/commons/a.jpg','https://upload.wikimedia.org/other/a.jpg']) assert.equal(safeImageUrl(url),null);
});
test('lookups cache shared metadata, hide upstream image URLs, and bound daily work', async () => {
  const env={DB:database()}; let calls=0;
  const fetcher=async url=>{calls++;const action=new URL(url).searchParams.get('action');return Response.json(action==='wbsearchentities'?{search:[{id:'Q1'}]}:action==='wbgetentities'?{entities:{Q1:boxer}}:{query:{pages:{1:{imagerepository:'local',imageinfo:[info]}}}});};
  const photo=await getPortrait(env,'Test Boxer',{now:100000,fetcher});
  assert.equal(photo.available,true); assert.match(photo.imageUrl,/^\/media\/portraits\/[a-f0-9]{64}$/);
  assert.deepEqual(await getPortrait(env,'TEST BOXER',{now:100001,fetcher}),photo); assert.equal(calls,3);
  await env.DB.prepare('INSERT INTO portrait_lookup_usage VALUES (?,40)').bind('1970-01-03').run();
  assert.equal((await getPortrait(env,'Another Boxer',{now:200000,fetcher})).available,false); assert.equal(calls,3);
});
test('image proxy serves only cached licensed images and refuses foreign redirects and oversized bodies', async()=>{
  const env={DB:database()}; const key=await portraitKey('Test Boxer');
  assert.equal((await getPortraitImage(env,key)).status,404);
  await env.DB.prepare('INSERT INTO fighter_portraits (id,name,payload_json) VALUES (?,?,?)').bind(key,'Test Boxer',JSON.stringify(commonsPortrait(info,'Photo.jpg','Q1'))).run();
  const image=await getPortraitImage(env,key,{fetcher:async()=>new Response(new Uint8Array([1,2]),{headers:{'Content-Type':'image/jpeg'}})});
  assert.equal(image.status,200);assert.equal(image.headers.get('Cache-Control'),'public, max-age=86400');
  assert.equal((await getPortraitImage(env,key,{fetcher:async()=>new Response(null,{status:302,headers:{Location:'https://example.com/photo.jpg'}})})).status,502);
  assert.equal((await getPortraitImage(env,key,{fetcher:async()=>new Response(new Uint8Array(1500001),{headers:{'Content-Type':'image/jpeg'}})})).status,502);
});
