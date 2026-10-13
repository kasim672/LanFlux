/* Reports contain observed transfer records only. They never send measurements to Python. */
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const DIGEST = /^[a-f0-9]{64}$/;
const pendingDownloads = new Map();

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const cleanText = (value,limit=240) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,limit);
const measured = (value,precision=3) => finite(value) === null ? 'Unavailable' : value.toFixed(precision);
const timestamp = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return 'Unavailable';
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : 'Unavailable';
};

export function experimentRecords(transfers,options={}) {
  const values = transfers instanceof Map ? transfers.values() : transfers;
  return Array.from(values || []).filter(item => item && TERMINAL.has(item.status)).slice(-100).map(item => {
    const duration = finite(item.durationSeconds);
    const bytes = finite(item.bytes);
    const average = finite(item.averageSpeed) ?? (duration > 0 && bytes !== null ? bytes/duration : null);
    const digest = DIGEST.test(item.sha256 || '') ? item.sha256 : null;
    const actual = DIGEST.test(item.actualSha256 || '') ? item.actualSha256 : null;
    const verification = item.hashStatus === 'verified' && digest && actual && digest === actual ? 'Verified' :
      item.hashStatus === 'failed' ? 'Failed' : 'Unavailable';
    return {
      fileName:cleanText(item.name), fileSizeBytes:finite(item.size), direction:item.direction === 'receive' ? 'receive' : 'send',
      bytesTransferred:bytes, connectionSetupMs:finite(item.connectionSetupMs), transferDurationSeconds:duration,
      averageThroughputMbps:average === null ? null : average*8/1e6,
      peakObservedThroughputMbps:finite(item.peakBytesPerSecond) === null ? null : item.peakBytesPerSecond*8/1e6,
      result:cleanText(item.status), sha256Verification:verification, expectedSha256:digest, receivedSha256:actual,
      route:['direct','relay'].includes(item.route) ? item.route : 'Unavailable',
      startedAt:timestamp(item.startedAt), finishedAt:timestamp(item.finishedAt),
      resultReason:cleanText(item.resultReason || item.error || (item.status === 'completed' ? 'Transfer completed and bytes verified' : '')),
      environmentLabel:cleanText(options.environmentLabel,120), notes:cleanText(options.notes,1000),
    };
  });
}

export function buildExperimentReport(transfers,options={}) {
  const records = experimentRecords(transfers,options);
  const lines = [
    'LANFLUX 0.3.0 — observed networking measurements',
    `Generated: ${new Date().toISOString()}`,
    `Recorded terminal transfers: ${records.length}`,
    `Environment label (entered by user): ${cleanText(options.environmentLabel,120) || 'Not supplied'}`,
    `Notes (entered by user): ${cleanText(options.notes,1000) || 'Not supplied'}`,
    '',
    'Units: Mbps = payload bytes/second × 8 / 1,000,000. MiB = 1,048,576 bytes.',
    'Duration: approval/start of payload transmission through verified completion acknowledgement (sender) or verified receive completion (receiver).',
    'Setup: pairing/peer discovery through DataChannel open; reused connections retain the original setup measurement.',
    'Peak: highest full sampling-interval payload rate; Unavailable if no interval was observed.',
    'Application payload rates include browser/protocol delays and exclude transport headers; they are not physical link capacity.',
    'A matching SHA-256 proves byte integrity relative to the peer metadata, not the sender’s real-world identity.',
    'No automatic resume. These are actual browser measurements; no benchmark results are synthesized.',
    '',
  ];
  for (const [index,row] of records.entries()) lines.push(
    `${index+1}. ${row.fileName} (${row.direction})`,
    `   File size: ${row.fileSizeBytes ?? 'Unavailable'} bytes; transferred: ${row.bytesTransferred ?? 'Unavailable'} bytes`,
    `   Setup: ${measured(row.connectionSetupMs)} ms; transfer: ${measured(row.transferDurationSeconds)} s`,
    `   Average: ${measured(row.averageThroughputMbps)} Mbps; peak observed: ${measured(row.peakObservedThroughputMbps)} Mbps`,
    `   Result: ${row.result}; SHA-256: ${row.sha256Verification}; route: ${row.route}`,
    `   Expected SHA-256: ${row.expectedSha256 || 'Unavailable'}`,
    `   Received SHA-256: ${row.receivedSha256 || 'Unavailable'}`,
    `   Started: ${row.startedAt}; finished: ${row.finishedAt}`,
    `   Reason: ${row.resultReason || 'Unavailable'}`, '',
  );
  if (!records.length) lines.push('No terminal transfer observations have been collected.');
  return lines.join('\n');
}

function csvCell(value) {
  let text = value === null || value === undefined ? 'Unavailable' : String(value);
  // Spreadsheet formula injection protection for all user-controlled text.
  if (/^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}

export function experimentsToCsv(transfers,options={}) {
  const rows = experimentRecords(transfers,options);
  const columns = [
    ['file_name','fileName'],['file_size_bytes','fileSizeBytes'],['direction','direction'],['payload_bytes','bytesTransferred'],
    ['connection_setup_ms','connectionSetupMs'],['transfer_duration_seconds','transferDurationSeconds'],
    ['average_throughput_mbps','averageThroughputMbps'],['peak_observed_throughput_mbps','peakObservedThroughputMbps'],
    ['result','result'],['sha256_verification','sha256Verification'],['expected_sha256','expectedSha256'],['received_sha256','receivedSha256'],
    ['connection_type','route'],['started_at','startedAt'],['finished_at','finishedAt'],['result_reason','resultReason'],
    ['environment_label_user_entered','environmentLabel'],['notes_user_entered','notes'],
  ];
  return [columns.map(([name])=>csvCell(name)).join(','),...rows.map(row=>columns.map(([,key])=>csvCell(row[key])).join(','))].join('\r\n')+'\r\n';
}

export function releaseExportDownloads() {
  for (const [url,timer] of pendingDownloads) { clearTimeout(timer); URL.revokeObjectURL(url); }
  pendingDownloads.clear();
}

export function downloadText(text,name,type='text/plain') {
  if (pendingDownloads.size >= 8) releaseExportDownloads();
  const mimeType = type.includes('charset=') ? type : `${type};charset=utf-8`;
  const url = URL.createObjectURL(new Blob([text],{type:mimeType}));
  const anchor = document.createElement('a');
  anchor.href=url; anchor.download=name; anchor.rel='noopener';
  document.body.append(anchor); anchor.click(); anchor.remove();
  pendingDownloads.set(url,setTimeout(() => {URL.revokeObjectURL(url);pendingDownloads.delete(url);},10000));
}
