import map from './map-data.json' with {type:'json'};
import {APIError,Data} from './backend.ts';
const normalize=(value:unknown)=>String(value??'').replace(/<[^>]*>/g,' ').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function inside(lat:number,lng:number,ring:number[][]) {
  let hit=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const a=ring[i],b=ring[j];
    if((a[1]>lat)!==(b[1]>lat)&&lng<(b[0]-a[0])*(lat-a[1])/(b[1]-a[1])+a[0]) hit=!hit;
  }
  return hit;
}
function buildingAt(lat:number,lng:number) {
  const candidates=map.buildings.map((building:any)=>({building,distance:Math.hypot((lat-building.lat)*111320,(lng-building.long)*111320*Math.cos(lat*Math.PI/180))})).sort((a:any,b:any)=>a.distance-b.distance);
  return candidates.find((item:any)=>item.building.polygons.some((ring:number[][])=>inside(lat,lng,ring)))?.building
    || (candidates[0]?.distance<=120 ? candidates[0].building:null);
}
export function eventHint(event:Data):Data|null {
  const title=normalize(event.title),text=normalize(event.title+' '+event.description),hosts=normalize(event.hosts.join(' '));
  let probability:number,reason:string;
  if(/\bknightro\b/.test(text)) {
    if(/\b(no|without|not|cancelled|canceled)\b.{0,35}\bknightro\b|\bknightro\b.{0,35}\b(not attending|cancelled|canceled|will not)\b/.test(text)) return null;
    probability=.95;reason='Event listing mentions Knightro';
  } else if(/\b(pep rally|homecoming kickoff|homecoming parade|spirit splash)\b/.test(title)) {probability=.85;reason='Campus spirit event; mascot attendance is possible';}
  else if(hosts.includes('ucf athletics')&&/\b(football|basketball|volleyball)\b.*\b(vs|versus|home game)\b/.test(title)) {probability=.8;reason='UCF Athletics home event; mascot attendance is possible';}
  else return null;
  const place=normalize(event.location);
  let building:any=map.buildings.find((b:any)=>[b.name,...b.aliases.filter((a:string)=>a.length>=3)].some((name:string)=>new RegExp('\\b'+escape(normalize(name))+'\\b').test(place)));
  if(!building&&typeof event.lat==='number'&&typeof event.long==='number'&&Number.isFinite(event.lat)&&Number.isFinite(event.long)) building=buildingAt(event.lat,event.long);
  if(!building) return null;
  return {...event,lat:building.lat,long:building.long,buildingId:building.id,buildingName:building.name,campus:building.campus,probability,reason};
}
export function validateFeed(feed:Data):Data[] {
  if(feed.available!==true||feed.complete!==true||!Number.isInteger(feed.generatedAt)||!Array.isArray(feed.events)||feed.events.length>5000) throw new APIError(400,'Import a completed scraper database snapshot.');
  const seen=new Set<string>();const events:Data[]=[];
  for(const value of feed.events) {
    if(!value||typeof value!=='object'||!/^[0-9]{1,32}$/.test(value.eventId)||seen.has(value.eventId)
      || typeof value.title!=='string'||!value.title.trim()||value.title.length>1000
      || typeof value.description!=='string'||value.description.length>100000
      || !Number.isInteger(value.startsAt)||!Number.isInteger(value.endsAt)||value.endsAt<value.startsAt
      || typeof value.location!=='string'||value.location.length>4000
      || !Array.isArray(value.hosts)||value.hosts.length>100||value.hosts.some((h:unknown)=>typeof h!=='string'||h.length>1000)
      ||value.url!=='https://knightconnect.campuslabs.com/engage/event/'+value.eventId) throw new APIError(400,'Invalid scraper event record. Previous feed was preserved.');
    seen.add(value.eventId);
    const event={eventId:value.eventId,title:value.title,description:value.description,startsAt:value.startsAt,endsAt:value.endsAt,
      location:value.location,lat:typeof value.lat==='number'&&Number.isFinite(value.lat)?value.lat:null,
      long:typeof value.long==='number'&&Number.isFinite(value.long)?value.long:null,hosts:value.hosts,url:value.url};
    const hint=eventHint(event);if(hint) events.push(hint);
  }
  return events;
}
