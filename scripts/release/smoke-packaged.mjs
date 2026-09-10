// Launch the exact packaged app, isolating its data before its entry point runs.
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import net from 'node:net';
const executable = resolve(process.argv[2] ?? '');
async function port() { const server=net.createServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r)); const p=server.address().port; await new Promise(r=>server.close(r)); return p; }
const inspector=await port(), renderer=await port();
const data=await mkdtemp(join(tmpdir(),'munhae-package-smoke-'));
await mkdir(join(data,'logs'));
const child=spawn(executable,[`--inspect-brk=127.0.0.1:${inspector}`,`--remote-debugging-port=${renderer}`],{stdio:['ignore','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
let output=''; child.stdout.on('data',b=>output+=b); child.stderr.on('data',b=>output+=b);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function targets(p){for(let i=0;i<100;i++){try {const r=await fetch(`http://127.0.0.1:${p}/json/list`); if(r.ok) return await r.json();}catch{} if(child.exitCode!==null)throw Error('Packaged process exited early: '+output); await sleep(200);}throw Error('Debug endpoint unavailable: '+output);}
async function connect(url){const ws=new WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let seq=0;const pending=new Map(),events=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Error(m.error.message)):p?.resolve(m.result);}else{events.get(m.method)?.(m.params);}};return {ws,send(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});},once(method){return new Promise(r=>events.set(method,r));}};}
let main, page;
const deadline=setTimeout(()=>{console.error('Packaged smoke timed out');child.kill();process.exitCode=1;},60000);
try{
 main=await connect((await targets(inspector))[0].webSocketDebuggerUrl);
 await main.send('Debugger.enable'); const paused=main.once('Debugger.paused');await main.send('Runtime.runIfWaitingForDebugger');let frame=(await paused).callFrames[0];
 await main.send('Debugger.setBreakpoint',{location:{scriptId:frame.location.scriptId,lineNumber:3}}); const entry=main.once('Debugger.paused');await main.send('Debugger.resume');frame=(await entry).callFrames[0];
 const setup=await main.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:`app.setPath('userData', ${JSON.stringify(data)}); app.setAppLogsPath(${JSON.stringify(join(data,'logs'))}); JSON.stringify({userData: app.getPath('userData'), arch: process.arch, electron: process.versions.electron})`,returnByValue:true});
 if(setup.exceptionDetails || !setup.result?.value || JSON.parse(setup.result.value).userData !== data)throw Error('Failed to isolate packaged data: '+JSON.stringify(setup));
 console.log('Isolated packaged runtime: '+setup.result.value);
 await main.send('Debugger.resume');
 let result;
 for(let i=0;i<100;i++){
  const tabs=await targets(renderer); const target=tabs.find(x=>x.type==='page' && /\/(index|home|account)\.html/.test(x.url));
  if(target){page=await connect(target.webSocketDebuggerUrl);result=await page.send('Runtime.evaluate',{expression:'JSON.stringify({title:document.title,text:document.body.innerText.slice(0,1800),preload:typeof window.munhae})',returnByValue:true});if(result.result?.value && JSON.parse(result.result.value).text.length>10)break;page.ws.close();page=null;}
  await sleep(300);
 }
 if(!result?.result?.value)throw Error('Main renderer did not load: '+output);
 console.log('Packaged renderer: '+result.result.value);
 await writeFile(join(data,'smoke-output.log'),output);
 console.log('SMOKE PASS — startup and renderer only; not an OS compatibility or signed-install test.');
}finally{clearTimeout(deadline);page?.ws.close();main?.ws.close();child.kill();}
