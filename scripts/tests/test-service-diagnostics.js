'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-diagnostics-'));
const markers = ['SYNTHETIC_RECORD', 'SYNTHETIC_TOKEN', 'SYNTHETIC_EXCEPTION', 'SYNTHETIC_PATH', 'SYNTHETIC_MISSING'];

function noSensitiveContent(text) {
  for (const marker of markers) assert.ok(!text.includes(marker), `Diagnostic content escaped: ${marker}`);
}
function records(file) {
  const content = fs.readFileSync(file, 'utf8');
  noSensitiveContent(content);
  const rows = content.trim().split('\n').map(line => JSON.parse(line));
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['event', 'exit_code', 'service', 'timestamp_ms']);
    assert.ok(['surrealdb', 'api', 'worker'].includes(row.service));
    assert.ok(['started', 'exited', 'spawn_failed', 'process_error', 'wait_failed'].includes(row.event));
    assert.ok(Number.isSafeInteger(row.timestamp_ms) && row.timestamp_ms > 0);
    assert.ok(row.exit_code === null || Number.isInteger(row.exit_code));
  }
  return rows;
}
function javascriptChildren() {
  const logs = path.join(temporary, 'javascript');
  fs.mkdirSync(logs);
  const legacy = path.join(logs, 'api.log');
  fs.writeFileSync(legacy, 'SYNTHETIC_RECORD legacy log remains untouched');
  const fixture = `process.stdout.write('SYNTHETIC_RECORD\\n'.repeat(100000)); process.stderr.write('SYNTHETIC_TOKEN'); process.exitCode=23;`;
  const script = `
    const {spawnServiceProcess}=require(${JSON.stringify(path.join(root,'scripts/service-diagnostics.js'))});
    const closed=child=>new Promise(resolve=>child.once('close',resolve));
    (async()=>{
      const options={logsDir:${JSON.stringify(logs)},env:process.env,cwd:${JSON.stringify(temporary)}};
      const child=spawnServiceProcess('api',process.execPath,['-e',${JSON.stringify(fixture)}],options);
      if(await closed(child)!==23) throw Error('CHILD_EXIT_UNEXPECTED');
      const crashed=spawnServiceProcess('surrealdb',process.execPath,['-e',"throw Error('SYNTHETIC_EXCEPTION Unicode: \\u00e9');"],options);
      if(await closed(crashed)!==1) throw Error('CHILD_EXCEPTION_UNEXPECTED');
      await closed(spawnServiceProcess('worker',${JSON.stringify(path.join(temporary,'SYNTHETIC_MISSING.exe'))},[],options));
      const fs=require('node:fs');
      const write=fs.writeSync;
      fs.writeSync=()=>{throw Error('SYNTHETIC_EXCEPTION');};
      await closed(spawnServiceProcess('worker',process.execPath,['-e','process.exitCode=0;'],options));
      fs.writeSync=write;
      try {spawnServiceProcess('SYNTHETIC_RECORD',process.execPath,[],options);throw Error('VALIDATION_MISSING');}
      catch(error){if(error.message!=='SERVICE_DIAGNOSTIC_INVALID_SERVICE')throw error;console.log(error.message);}
      try {spawnServiceProcess('api',process.execPath,[],{...options,logsDir:${JSON.stringify(path.join(temporary,'SYNTHETIC_PATH_missing'))}});throw Error('VALIDATION_MISSING');}
      catch(error){if(error.message!=='SERVICE_DIAGNOSTIC_OPEN_FAILED')throw error;console.log(error.message);}
    })().catch(()=>{console.error('TEST_CHILD_FAILED');process.exitCode=1;});`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding:'utf8', timeout:30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  noSensitiveContent(result.stdout + result.stderr);
  assert.ok(result.stderr.includes('SERVICE_DIAGNOSTIC_WRITE_FAILED'));
  assert.ok(records(path.join(logs,'api.lifecycle.jsonl')).some(row=>row.event==='exited' && row.exit_code===23));
  assert.ok(records(path.join(logs,'surrealdb.lifecycle.jsonl')).some(row=>row.event==='exited' && row.exit_code===1));
  assert.ok(records(path.join(logs,'worker.lifecycle.jsonl')).some(row=>row.event==='spawn_failed'));
  assert.equal(fs.readFileSync(legacy,'utf8'),'SYNTHETIC_RECORD legacy log remains untouched');
}
function cliErrors() {
  const blocked = path.join(temporary,'SYNTHETIC_PATH_blocked');
  fs.writeFileSync(blocked,'not a directory');
  const result = spawnSync(process.execPath,[path.join(root,'scripts/run-services.js'),'--data',blocked],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,1);
  noSensitiveContent(result.stdout+result.stderr);
  assert.ok(result.stderr.includes('SERVICE_STARTUP_FAILED'));
}
async function electronErrors(mode) {
  const messages=[];
  const handlers=new Map();
  const app={isPackaged:false,whenReady:()=>Promise.resolve(),getPath:()=>path.join(temporary,'SYNTHETIC_PATH'),exit:()=>{},quit:()=>{},on:(event,fn)=>handlers.set(event,fn)};
  class Window {
    constructor(){this.webContents={setWindowOpenHandler(){},on(){}};}
    loadURL(){}
    on(){}
  }
  const fakeFs={existsSync:file=>mode!=='missing' || file.endsWith('encryption-key.txt'),readFileSync:()=>{
    if(mode==='key-error')throw Error('SYNTHETIC_EXCEPTION');return 'synthetic key';
  }};
  const dependencies={electron:{app,BrowserWindow:Window,shell:{},dialog:{showErrorBox:(...values)=>messages.push(...values)}},path,fs:fakeFs,
    './scripts/start-services':{startServices:async()=>{
      if(mode==='startup')throw Error('SYNTHETIC_EXCEPTION');
      return {stop:async()=>{throw Error('SYNTHETIC_EXCEPTION');}};
    }},
    './scripts/lib/credentials':{
      ensureEncryptionKey:()=>{
        if(mode==='key-error')throw Error('SYNTHETIC_EXCEPTION');
        return 'synthetic key';
      },
      resolveDatabaseCredentials:()=>({user:'root',password:'synthetic',legacy:false,source:'stored'}),
    }};
  vm.runInNewContext(fs.readFileSync(path.join(root,'main.js'),'utf8'),{
    require:name=>{assert.ok(Object.hasOwn(dependencies,name));return dependencies[name];},
    __dirname:path.join(temporary,'SYNTHETIC_PATH'),console:{error:(...values)=>messages.push(...values)},
  });
  await new Promise(resolve=>setImmediate(resolve));
  if(mode==='shutdown'){
    handlers.get('before-quit')({preventDefault(){}});
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.ok(messages.length>0);
  noSensitiveContent(messages.map(String).join('\n'));
  if(mode==='shutdown')assert.ok(messages.includes('SERVICE_SHUTDOWN_FAILED'));
}
function nativeChildren() {
  const executable=path.join(temporary,process.platform==='win32'?'native-diagnostics.exe':'native-diagnostics');
  const compiled=spawnSync('rustc',['--edition=2021','--test',path.join(root,'src-tauri/tests/service_diagnostics.rs'),'-o',executable],{encoding:'utf8',timeout:120000});
  assert.equal(compiled.status,0,compiled.stderr || 'Rust compiler required for native diagnostics tests');
  const result=spawnSync(executable,[],{encoding:'utf8',timeout:30000,env:{...process.env,OE_DIAGNOSTIC_TEST_ROOT:temporary,OE_DIAGNOSTIC_TEST_NODE:process.execPath}});
  assert.equal(result.status,0,result.stdout+result.stderr);
  noSensitiveContent(result.stdout+result.stderr);
  for(const service of ['api','surrealdb','worker'])records(path.join(temporary,'native_output',`${service}.lifecycle.jsonl`));
  records(path.join(temporary,'native_missing','api.lifecycle.jsonl'));
}

(async()=>{
  javascriptChildren();
  cliErrors();
  for(const mode of ['missing','startup','shutdown','key-error'])await electronErrors(mode);
  nativeChildren();
  console.log('Diagnostics: real JS/Rust child output, exceptions, failures, and launcher errors contain only safe lifecycle metadata.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(temporary,{recursive:true,force:true}));
