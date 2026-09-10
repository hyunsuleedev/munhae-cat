import { afterEach, expect, test } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileCaptured, spawn } from "../src/process-launch";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, {recursive:true, force:true}))); });
test("probe captures exit failures and output", async () => {
 const result = await execFileCaptured(process.execPath, ["-e", "console.log('probe');process.exit(3)"], process.env);
 expect(result.stdout.trim()).toBe("probe"); expect(result.error).not.toBeNull();
});
test("probe enforces timeout", async () => {
 const result = await execFileCaptured(process.execPath, ["-e", "setTimeout(()=>{},10000)"], process.env, 100);
 expect(result.error?.code).toBe("ETIMEDOUT");
});
test.skipIf(process.platform !== "win32")("Windows npm shim preserves prompt arguments and stdin", async () => {
 const dir = await mkdtemp(join(tmpdir(), "munhae cli shim ")); directories.push(dir);
 await writeFile(join(dir,"probe.cjs"), "let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),input})));" );
 const shim = join(dir,"probe.cmd");
 await writeFile(shim, `@"${process.execPath}" "%~dp0probe.cjs" %*\r\n`);
 const args = ['한문 번역', 'a&b', 'quoted "text"', '%PATH%', 'a|b > test', '!hello!'];
 const child = spawn(shim,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stdout=''; child.stdout!.on('data',b=>stdout+=b); child.stdin!.end('원문\n번역');
 const code = await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 expect(code).toBe(0); expect(JSON.parse(stdout)).toEqual({args,input:'원문\n번역'});
 const probe = await execFileCaptured(shim, args, process.env);
 expect(probe.error).toBeNull(); expect(JSON.parse(probe.stdout).args).toEqual(args);
});
