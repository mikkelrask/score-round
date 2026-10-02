import { json } from './_middleware.js';
import { getFighter } from './_fighters.js';
import { fighterNameKey } from '../../fighter-data.js';
export async function onRequestGet({request,env}) {
  const params=new URL(request.url).searchParams, id=params.get('id'), name=params.get('name')?.trim();
  if(id ? !/^[a-zA-Z0-9_-]{1,100}$/.test(id) : !name || name.length>200 || fighterNameKey(name).length<3 || /[\x00-\x1f]/.test(name)) return json({error:'Choose a fighter name or ID.'},400);
  return json(await getFighter(env,{id,name}));
}
