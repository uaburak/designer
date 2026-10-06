import fs from 'node:fs';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

// minimal zip reader for stored entries
function readZip(buf){
  const files={}; let eocd=buf.length-22; while(buf.readUInt32LE(eocd)!==0x06054b50) eocd--;
  const n=buf.readUInt16LE(eocd+10); let off=buf.readUInt32LE(eocd+16);
  for(let i=0;i<n;i++){
    const method=buf.readUInt16LE(off+10), csize=buf.readUInt32LE(off+20), nameLen=buf.readUInt16LE(off+28), extraLen=buf.readUInt16LE(off+30), commLen=buf.readUInt16LE(off+32), lho=buf.readUInt32LE(off+42);
    const name=buf.toString('utf8',off+46,off+46+nameLen);
    const lnl=buf.readUInt16LE(lho+26), lel=buf.readUInt16LE(lho+28);
    const data=buf.subarray(lho+30+lnl+lel, lho+30+lnl+lel+csize);
    files[name]= method===0?data:zlib.inflateRawSync(data);
    off+=46+nameLen+extraLen+commLen;
  }
  return files;
}
class BB{constructor(b){this.b=b;this.i=0}
 byte(){return this.b[this.i++]}
 bool(){return this.byte()!==0}
 vu(){let r=0,s=0,c;do{c=this.byte();r|=(c&127)<<s;s+=7}while(c&128&&s<35);return r>>>0}
 vi(){const v=this.vu();return (v&1)?~(v>>>1):(v>>>1)}
 vu64(){let r=0n,s=0n,c;do{c=this.byte();r|=BigInt(c&127)<<s;s+=7n}while(c&128&&s<70n);return r}
 vi64(){const v=this.vu64();return (v&1n)?~(v>>1n):(v>>1n)}
 f(){const first=this.byte(); if(first===0) return 0; let bits=first|(this.byte()<<8)|(this.byte()<<16)|(this.byte()<<24); bits=(bits<<23)|(bits>>>9); const dv=new DataView(new ArrayBuffer(4)); dv.setUint32(0,bits>>>0,true); return dv.getFloat32(0,true)}
 str(){let s=this.i; while(this.b[this.i]!==0)this.i++; const r=Buffer.from(this.b.subarray(s,this.i)).toString('utf8'); this.i++; return r}
 bytes(){const n=this.vu(); const r=this.b.subarray(this.i,this.i+n); this.i+=n; return r}
}
const BUILTIN=['bool','byte','int','uint','float','string','int64','uint64'];
function decodeSchema(buf){const bb=new BB(buf); const defs=[]; const n=bb.vu();
 for(let i=0;i<n;i++){const name=bb.str(), kind=bb.byte(), fc=bb.vu(), fields=[];
  for(let j=0;j<fc;j++){const fname=bb.str(), type=bb.vi(), isArray=!!(bb.byte()&1), value=bb.vu(); fields.push({name:fname,type,isArray,value})}
  defs.push({name, kind:['ENUM','STRUCT','MESSAGE'][kind], fields})}
 for(const d of defs) for(const f of d.fields) f.typeName = f.type<0? BUILTIN[~f.type] : defs[f.type].name;
 return defs}
function makeDecoder(defs){const byName=Object.fromEntries(defs.map(d=>[d.name,d]));
 function val(bb,typeName){switch(typeName){case 'bool':return bb.bool();case 'byte':return bb.byte();case 'int':return bb.vi();case 'uint':return bb.vu();case 'float':return bb.f();case 'string':return bb.str();case 'int64':return bb.vi64().toString();case 'uint64':return bb.vu64().toString()}
  const d=byName[typeName];
  if(d.kind==='ENUM'){const v=bb.vu(); const f=d.fields.find(x=>x.value===v); return f?f.name:v}
  if(d.kind==='STRUCT'){const o={}; for(const f of d.fields) o[f.name]=field(bb,f); return o}
  const o={}; for(;;){const id=bb.vu(); if(id===0) return o; const f=d.fields.find(x=>x.value===id); if(!f) throw new Error('bad field '+id+' in '+typeName); o[f.name]=field(bb,f)}}
 function field(bb,f){if(f.isArray){ if(f.typeName==='byte') return Array.from(bb.bytes()); const n=bb.vu(), a=[]; for(let i=0;i<n;i++) a.push(val(bb,f.typeName)); return a} return val(bb,f.typeName)}
 return (buf,root)=>val(new BB(buf),root)}
function unpack(c){ if(c[0]===0x28&&c[1]===0xb5&&c[2]===0x2f&&c[3]===0xfd) return zlib.zstdDecompressSync(c); return zlib.inflateRawSync(c)}

const file=process.argv[2];
const zip=readZip(fs.readFileSync(file));
const c=zip['canvas.fig'];
const version=c.readUInt32LE(8); let off=12; const chunks=[];
while(off<c.length){const n=c.readUInt32LE(off); off+=4; chunks.push(c.subarray(off,off+n)); off+=n}
const defs=decodeSchema(unpack(chunks[0]));
const dec=makeDecoder(defs);
const msg=dec(unpack(chunks[1]),'Message');
const out={version, schemaDefs:defs.length, nodeChangeFieldCount: defs.find(d=>d.name==='NodeChange').fields.length, msgType:msg.type, msgKeys:Object.keys(msg), blobs:(msg.blobs||[]).length, nodes:msg.nodeChanges.length};
fs.writeFileSync(file+'.json', JSON.stringify(msg,(k,v)=> (Array.isArray(v)&&v.length>64&&typeof v[0]==='number')?`<${v.length} bytes>`:v,1));
fs.writeFileSync(file+'.schema.json', JSON.stringify(defs.map(d=>({name:d.name,kind:d.kind,fields:d.fields.map(f=>f.name+':'+f.typeName+(f.isArray?'[]':''))}))));
console.log(JSON.stringify(out));
