import jpeg from 'npm:jpeg-js@0.4.4';
import {APIError} from './backend.ts';

// Small server-decoded JPEGs bound CPU/memory on the free Edge runtime.
// Re-encoding strips EXIF, GPS, comments, and embedded thumbnails.
export function cleanPhoto(value:unknown):Uint8Array {
  if (typeof value!=='string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length>2800000) throw new APIError(400,'Attach a camera JPEG photo under 2 MB.');
  try {
    const raw=Uint8Array.from(atob(value.slice(23)),c=>c.charCodeAt(0));
    if (raw.length>2000000 || raw[0]!==255 || raw[1]!==216) throw new Error();
    const image=jpeg.decode(raw,{useTArray:true,formatAsRGBA:true,tolerantDecoding:false,maxResolutionInMP:2,maxMemoryUsageInMB:48});
    if (Math.min(image.width,image.height)<240 || Math.max(image.width,image.height)>1600) throw new Error();
    const scale=Math.min(1,800/Math.max(image.width,image.height));
    const width=Math.max(1,Math.round(image.width*scale)),height=Math.max(1,Math.round(image.height*scale));
    const data=new Uint8Array(width*height*4);
    for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
      const source=(Math.floor(y/scale)*image.width+Math.floor(x/scale))*4,destination=(y*width+x)*4;
      data.set(image.data.subarray(source,source+4),destination);
    }
    const result=new Uint8Array(jpeg.encode({width,height,data},65).data);
    if (result.length>300000) throw new Error();
    return result;
  } catch { throw new APIError(400,'This photo could not be read. Retake it using the tracker camera.'); }
}
