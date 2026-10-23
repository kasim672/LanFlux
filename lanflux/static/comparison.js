/* Local observed comparisons: no filenames, digests, peer IDs or private addresses. */
const TERMINAL = new Set(['completed','failed','cancelled','rejected']);
const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const mode = v => ['baseline','rules','ml'].includes(v) ? v : 'unknown';
const show = v => v == null ? 'Unavailable' : typeof v === 'number' ? Number(v.toFixed(4)) : v;
const cell = v => `"${String(show(v)).replaceAll('"','""')}"`;
const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
export function percentile(values, fraction) {
  const sorted = values.filter(v=>finite(v)!==null).sort((a,b)=>a-b);
  if (!sorted.length) return null;
  const position=(sorted.length-1)*Math.max(0,Math.min(1,fraction));
  const i=Math.floor(position);
  return sorted[i]+(sorted[Math.ceil(position)]-sorted[i])*(position-i);
}
export class StrategyComparison {
  constructor(now=()=>performance.now()){this.now=now;this.clear();}
  clear(){this.records=[];this.active=new Map();this.finished=new Set();this.receiving=new Set();this.sequence=0;}
  clearFinished(){this.records=[];}
  observeTransfer(t){
    if (!t || typeof t.id!=='string') return;
    if(t.direction==='receive'){
      if((t.payloadActive===true||t._meterActive===true) && !TERMINAL.has(t.status)){
        this.receiving.add(t.id);
        for(const e of this.active.values()) if(e.payloadActive)e.bidirectional=true;
      }else this.receiving.delete(t.id);
      return;
    }
    if(t.direction!=='send'||this.finished.has(t.id))return;
    let e=this.active.get(t.id);
    if(!e){
      if(this.active.size>=20)return;
      e={rtts:[],lastAt:null,effective:new Set(),bidirectional:false,payloadActive:false,startedAt:null};this.active.set(t.id,e);
    }
    e.payloadActive=(t.payloadActive===true||t._meterActive===true)&&!TERMINAL.has(t.status);
    if(e.payloadActive&&e.startedAt===null)e.startedAt=this.now();
    if(e.payloadActive&&this.receiving.size)e.bidirectional=true;
    if(e.payloadActive)e.effective.add(mode(t.effectiveStrategy));
    if(!TERMINAL.has(t.status))return;
    if(finite(t.pacingDelayMs)>0)e.effective.add(mode(t.effectiveStrategy));
    const seconds=finite(t.durationSeconds),bytes=finite(t.bytes);
    const verified=t.hashStatus==='verified'&&/^[a-f0-9]{64}$/.test(t.sha256||'')&&t.sha256===t.actualSha256;
    const effective=[...e.effective];
    this.records.push({run:++this.sequence,strategy:mode(t.strategy),effectiveStrategy:effective.length===1?effective[0]:effective.length>1?'mixed':mode(t.effectiveStrategy),
      fileSizeBytes:finite(t.size),route:['direct','relay'].includes(t.route)?t.route:'unknown',condition:e.bidirectional?'bidirectional':'outgoing-only',
      result:t.status==='completed'&&!verified?'unverified':t.status,integrity:verified?'verified':t.hashStatus==='failed'?'failed':'unavailable',
      payloadBytes:bytes,durationSeconds:seconds,throughputMbps:seconds>0&&bytes!==null?bytes*8/seconds/1e6:null,
      peakThroughputMbps:finite(t.peakBytesPerSecond)===null?null:t.peakBytesPerSecond*8/1e6,
      medianRttMs:e.rtts.length>=2?percentile(e.rtts,.5):null,p95RttMs:e.rtts.length>=20?percentile(e.rtts,.95):null,rttSamples:e.rtts.length,
      pacingDelayMs:finite(t.pacingDelayMs),setupMs:finite(t.connectionSetupMs)});
    if(this.records.length>100)this.records.shift();
    this.active.delete(t.id);this.finished.add(t.id);
    if(this.finished.size>200)this.finished.delete(this.finished.values().next().value);
  }
  observeDiagnostics(d){
    if(d?.dataChannelState!=='open')return;
    const rtt=finite(d.rttMs),at=finite(d.rttSampleAt);
    if(rtt===null||at===null)return;
    for(const e of this.active.values()){
      if(!e.payloadActive||at<e.startedAt||(e.lastAt!==null&&at<=e.lastAt))continue;
      e.lastAt=at;e.rtts.push(rtt);if(e.rtts.length>600)e.rtts.shift();
    }
  }
  snapshot(){
    const groups=new Map();
    for(const row of this.records){
      const key=[row.strategy,row.effectiveStrategy,row.fileSizeBytes,row.route,row.condition].join('|');
      if(!groups.has(key))groups.set(key,{strategy:row.strategy,effectiveStrategy:row.effectiveStrategy,fileSizeBytes:row.fileSizeBytes,route:row.route,condition:row.condition,rows:[]});
      groups.get(key).rows.push(row);
    }
    return {count:this.records.length,records:this.records.map(r=>({...r})),groups:[...groups.values()].map(({rows,...group})=>{
      const completed=rows.filter(r=>r.result==='completed'&&r.integrity==='verified');
      const available=key=>completed.map(r=>r[key]).filter(v=>v!==null);
      return {...group,runs:rows.length,completed:completed.length,failed:rows.filter(r=>['failed','unverified'].includes(r.result)).length,
        cancelled:rows.filter(r=>r.result==='cancelled').length,rejected:rows.filter(r=>r.result==='rejected').length,
        totalPacingDelayMs:rows.reduce((sum,row)=>sum+(row.pacingDelayMs??0),0),
        meanThroughputMbps:mean(available('throughputMbps')),meanDurationSeconds:mean(available('durationSeconds')),
        medianRunRttMs:percentile(available('medianRttMs'),.5),medianRunP95RttMs:percentile(available('p95RttMs'),.5)};
    })};
  }
  csv(){
    const columns=['run','strategy','effectiveStrategy','fileSizeBytes','route','condition','result','integrity','payloadBytes','durationSeconds','throughputMbps','peakThroughputMbps','medianRttMs','p95RttMs','rttSamples','pacingDelayMs','setupMs'];
    return [columns.map(cell).join(','),...this.records.map(r=>columns.map(k=>cell(r[k])).join(','))].join('\r\n')+'\r\n';
  }
  report(){
    const {count,groups}=this.snapshot();
    const lines=['LANFLUX — observed strategy comparison',`Terminal outgoing attempts: ${count}`,'',
      'Strategies: baseline = original sending; rules = observation-based pacing; ml = forecast-assisted pacing.',
      'Separate groups: requested/effective strategy, file size, observed route and bidirectional condition.',
      'Effective strategy indicates observed intervention, not exclusive pacing for the whole transfer; mixed means both baseline and intervention were observed.',
      'Completed statistics require matching SHA-256. Failed, cancelled and rejected attempts remain counted.',
      'Mbps = payload bytes × 8 / elapsed seconds / 1,000,000. RTT is application ping/pong latency.',
      'RTT uses up to the latest 600 distinct pings per payload interval; median needs 2 pings and p95 needs 20. Otherwise unavailable.',
      'Observational results do not prove a strategy causes improvement. Alternate run order and hold conditions comparable.',
      'No automatic winner, synthetic measurements, filenames, digests, private ICE addresses or credentials are included.',''];
    for(const g of groups)lines.push(`${g.strategy} / effective ${g.effectiveStrategy} | ${show(g.fileSizeBytes)} bytes | ${g.route} | ${g.condition}`,
      `Runs ${g.runs}; verified completions ${g.completed}; failed ${g.failed}; cancelled ${g.cancelled}; rejected ${g.rejected}`,
      `Mean completed throughput ${show(g.meanThroughputMbps)} Mbps; mean duration ${show(g.meanDurationSeconds)} s`,
      `Median of run medians ${show(g.medianRunRttMs)} ms; median of run p95 values ${show(g.medianRunP95RttMs)} ms`,'');
    if(!count)lines.push('No observations collected. Send files to collect real measurements.');
    return lines.join('\n');
  }
}
