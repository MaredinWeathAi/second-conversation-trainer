#!/usr/bin/env node
/* src/ is the source of truth. public/index.html is generated — do not hand-edit it.
   Everything is inlined into one file: the app has to work as a single request. */
const fs=require("fs"),path=require("path");
const SRC=path.join(__dirname,"src");
const ORDER=["data.js","engine.js","app1.js","app2.js","app3.js","app4.js","app5.js","app6.js"];
const rd=f=>fs.readFileSync(path.join(SRC,f),"utf8");
const out=rd("shell.html")+"\n<script>\n"+ORDER.map(rd).join("\n")+"\n</script>\n";
const dest=path.join(__dirname,"public","index.html");
fs.writeFileSync(dest,out);
console.log("built public/index.html — %d bytes from %d modules",out.length,ORDER.length+1);
