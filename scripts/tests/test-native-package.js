'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'package-native.js'), 'utf8');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'oeon-native-package-'));
try {
  for (const dynamicLoader of [true, false]) {
    const root = path.join(temporary, dynamicLoader ? 'dynamic' : 'static');
    const runtime = path.join(root, 'isolated-runtime');
    const release = path.join(root, 'src-tauri', 'target', 'release');
    fs.mkdirSync(release, {recursive:true});
    fs.writeFileSync(path.join(release, 'office-equity-host-tauri.exe'), 'synthetic executable');
    if (dynamicLoader) fs.writeFileSync(path.join(release, 'WebView2Loader.dll'), 'synthetic loader');
    for (const directory of ['python', 'backend/open_notebook', 'surreal', 'frontend/static']) fs.mkdirSync(path.join(runtime, directory), {recursive:true});
    fs.writeFileSync(path.join(runtime, 'python/python.exe'), 'synthetic python');
    fs.writeFileSync(path.join(runtime, 'surreal/surreal.exe'), 'synthetic surreal');
    fs.writeFileSync(path.join(runtime, 'frontend/static/index.html'), 'synthetic frontend');
    const commands = [];
    vm.runInNewContext(source, {
      __dirname:path.join(root, 'scripts'),
      require:name => name === 'child_process' ? {spawnSync:(command,args)=>{commands.push({command,args});return {status:0};}} : require(name),
      process:{argv:['node','package-native.js','--runtime',runtime,'--out',path.join(root,'out')],platform:'win32',exit:code=>{throw Error('Unexpected package exit '+code);}},
      console:{log(){},warn(){},error(){}},
    });
    const output = path.join(root, 'out', 'Office of Equity Open Notebook');
    assert.equal(fs.readFileSync(path.join(output, 'Office of Equity Open Notebook.exe'),'utf8'), 'synthetic executable');
    assert.equal(fs.readFileSync(path.join(output, 'resources/runtime/frontend/static/index.html'),'utf8'), 'synthetic frontend');
    assert.equal(commands[0].command, 'cargo');
    if (dynamicLoader) assert.equal(fs.readFileSync(path.join(output, 'WebView2Loader.dll'),'utf8'), 'synthetic loader');
    else assert.equal(fs.existsSync(path.join(output,'WebView2Loader.dll')),false);
  }
  console.log('Native packaging preserves emitted WebView2 loader and supports isolated runtime input.');
} finally {
  fs.rmSync(temporary, {recursive:true,force:true});
}
