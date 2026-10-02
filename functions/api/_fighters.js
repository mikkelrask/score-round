import { normalizeFighter, matchFighter, fighterNameKey } from '../../fighter-data.js';
import { reserveRequest, CACHE_ID } from './_schedule.js';
export async function getFighter(env, {id, name}, {now=Math.floor(Date.now()/1000), fetcher=fetch}={}) {
  const DB=env.DB, key=id ? `id:${id}` : `name:${fighterNameKey(name)}`;
  await DB.prepare('INSERT OR IGNORE INTO fighter_profile_cache (id) VALUES (?)').bind(key).run();
  const row=await DB.prepare('SELECT * FROM fighter_profile_cache WHERE id=?').bind(key).first();
  const cached=row.payload_json ? JSON.parse(row.payload_json) : null;
  const snapshot = payload => ({...payload, fetchedAt: row.fetched_at ? new Date(row.fetched_at*1000).toISOString() : null});
  if(row.refresh_after>now && cached) return snapshot(cached);
  if(!env.BOXING_RAPIDAPI_KEY) return cached ? {...snapshot(cached),stale:true} : {available:false,reason:'Fighter profiles are not connected.'};
  const token=crypto.randomUUID();
  const lease=await DB.prepare('UPDATE fighter_profile_cache SET lease_token=?, lease_until=? WHERE id=? AND lease_until<=? AND refresh_after<=?').bind(token,now+20,key,now,now).run();
  if(!lease.meta.changes) return cached ? {...snapshot(cached),stale:true} : {available:false,reason:'This profile is loading. Try again shortly.'};
  let result, ttl=86400*7, fetchedAt=now;
  try {
    const month=new Date(now*1000).toISOString().slice(0,7);
    const allowance=await DB.prepare('INSERT INTO fighter_profile_usage (month,requests) VALUES (?,1) ON CONFLICT(month) DO UPDATE SET requests=requests+1 WHERE requests<20').bind(month).run();
    if(!allowance.meta.changes) throw new Error('The profile request budget is used up for this month.');
    await DB.prepare('INSERT OR IGNORE INTO fight_schedule_cache (id) VALUES (?)').bind(CACHE_ID).run();
    await reserveRequest(DB,now,10);
    const url=id ? `https://boxing-data-api.p.rapidapi.com/v2/fighters/${encodeURIComponent(id)}` : `https://boxing-data-api.p.rapidapi.com/v2/fighters/?${new URLSearchParams({name,page_size:'10'})}`;
    const response=await fetcher(url,{headers:{'X-RapidAPI-Key':env.BOXING_RAPIDAPI_KEY,'X-RapidAPI-Host':'boxing-data-api.p.rapidapi.com'},signal:AbortSignal.timeout(8000),redirect:'manual'});
    const remaining=response.headers.get('x-ratelimit-requests-remaining'), reset=response.headers.get('x-ratelimit-requests-reset');
    if(/^\d+$/.test(remaining || '') && /^\d+$/.test(reset || '')) await DB.prepare('UPDATE fight_schedule_cache SET requests_remaining=?, quota_reset_at=? WHERE id=?').bind(Number(remaining),now+Number(reset),CACHE_ID).run();
    if(!response.ok || Number(response.headers.get('content-length'))>1500000) throw new Error('This profile is unavailable on the current subscription.');
    const payload=await response.json();
    if(payload.error?.code) throw new Error('This profile is unavailable on the current subscription.');
    let fighter;
    if(id) { const raw=Array.isArray(payload.data) ? payload.data[0] : payload.data; fighter=raw?.id===id ? normalizeFighter(raw) : null; }
    else {
      const records=Array.isArray(payload.data) ? payload.data : [];
      const complete=!(Number(payload.pagination?.total_items)>records.length || Number(payload.pagination?.total_pages)>1);
      fighter=complete ? matchFighter(name,records) : null;
    }
    result=fighter ? {available:true,fighter,stale:false} : {available:false,reason:'No unique fighter profile could be matched.'};
  } catch(error) {
    result=cached?.available ? {...cached,stale:true,notice:'Showing a saved profile. '+error.message} : {available:false,reason:error.message};
    fetchedAt=cached?.available ? row.fetched_at : now; ttl=3600;
  }
  await DB.prepare('UPDATE fighter_profile_cache SET payload_json=?,fetched_at=?,refresh_after=?,lease_until=0,lease_token=NULL WHERE id=? AND lease_token=?').bind(JSON.stringify(result),fetchedAt,now+ttl,key,token).run();
  return {...result,fetchedAt:new Date(fetchedAt*1000).toISOString()};
}
