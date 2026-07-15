/* ============================================================================
   AI ADVOCATE v11 — Google Apps Script backend
   Sheets: ActivityLog | Sessions | Queue

   Owns the shared-profile GATE (one person on Saqib's Upwork profile at a time)
   and the activity/session LOG. Proposal generation stays in the app on the
   /api/claude Vercel proxy — the claude() action here is a fallback only.

   SETUP (one time, ~5 min):
   1. Google Sheet -> Extensions -> Apps Script -> paste this file -> Save
   2. Project Settings (gear) -> Script Properties:
        CLAUDE_API_KEY  =  sk-ant-api03-...
        CLAUDE_MODEL    =  claude-sonnet-4-6   (optional override)
   3. Deploy -> Manage deployments -> Edit -> Version: "New version" -> Deploy
      The /exec URL does NOT change on redeploy.
   4. Run setup() once to create the sheets.
============================================================================ */

var TABS = {
  ActivityLog: ["Timestamp","User","Type","Decision","Client","Job","Match","Total /19","Country","Budget","Duration (min)","Detail","Summary"],
  Sessions:    ["Session ID","User","Login Time","Logout Time","Duration (min)","Duration (h:m)","JDs","Proposals","Copies","Status"],
  Queue:       ["Holder","HolderSince","Waiting","PendingOffer","UpdatedAt","HolderHeartbeat"],
  CLEval:      ["Assignee","Date","Time PKT","Job Title","Job Link","Hiring Rate","Client Ratings","Payment Method Verified?","Total Spend","Proposals","Interviewing","Invites sent","Unanswered Invites","Flag","Applied?","Fixed/Hourly","High Bid","Avg. Bid","Low bid","No. of Connects","Bid","Reason","Job posted","Open jobs"]
};

/* Must match SEAT_ADMINS in index.html, and the names in its TEAM list. */
var ADMINS   = ["Saqib Shahzad","Jahanzaib (Zeb)"];
var STALE_MS = 12 * 60 * 1000; // 12 min without heartbeat -> auto-release
var LOCK_MS  = 10 * 1000;      // how long to wait for the gate lock

/* ---- sheet helpers ---- */
function ss_()  { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name){
  var s = ss_().getSheetByName(name);
  if(!s){ s = ss_().insertSheet(name); s.appendRow(TABS[name]||["Timestamp","Data"]); s.setFrozenRows(1); }
  return s;
}
function setup(){ Object.keys(TABS).forEach(function(n){ sheet_(n); }); readQueue_(); return "setup ok"; }
function hm_(min){ min=Math.round(min||0); var h=Math.floor(min/60),m=min%60; return h+"h "+m+"m"; }

/* ---- queue I/O ---- */
function readQueue_(){
  var s = sheet_("Queue");
  if(s.getLastRow()<2){ s.appendRow(["","","","",new Date(),""]); }
  var r = s.getRange(2,1,1,6).getValues()[0];
  var waiting = r[2] ? String(r[2]).split(" || ").filter(String).map(function(x){
    var p=x.split("|"); return {name:p[0],bookedAt:p[1]||""}; }) : [];
  var q = {holder:r[0]||null,holderSince:r[1]||null,waiting:waiting,pendingOffer:r[3]||null,holderHeartbeat:r[5]||null};

  /* auto-release a holder who stopped sending heartbeats (crashed tab, closed laptop) */
  if(q.holder && q.holderHeartbeat){
    var lastHb = new Date(q.holderHeartbeat).getTime();
    if(!isNaN(lastHb) && (Date.now()-lastHb)>STALE_MS){
      var staleHolder = q.holder;
      q.holder=null; q.holderSince=null; q.holderHeartbeat=null;
      q.pendingOffer = q.waiting.length ? q.waiting[0].name : null;
      writeQueue_(q);
      sheet_("ActivityLog").appendRow([new Date(),staleHolder,"AUTO_RELEASE","","","","","","","","",
        "Auto-released after 12 min inactivity (heartbeat timeout).",""]);
    }
  }
  return q;
}
function writeQueue_(q){
  var s=sheet_("Queue");
  if(s.getLastRow()<2) s.appendRow(["","","","",new Date(),""]);
  var w=(q.waiting||[]).map(function(x){return x.name+"|"+(x.bookedAt||"");}).join(" || ");
  s.getRange(2,1,1,6).setValues([[q.holder||"",q.holderSince||"",w,q.pendingOffer||"",new Date(),q.holderHeartbeat||""]]);
  return q;
}

/* ---- gate transitions ---- */
function qJoin_(q,name){
  if(!q.holder){
    q.holder=name; q.holderSince=new Date().toISOString(); q.holderHeartbeat=new Date().toISOString();
    return "HOLDER";
  }
  if(q.holder===name){ q.holderHeartbeat=new Date().toISOString(); return "HOLDER"; }
  if(q.waiting.some(function(x){return x.name===name;})) return "ALREADY_WAITING";
  q.waiting.push({name:name,bookedAt:new Date().toISOString()});
  return "WAITING#"+q.waiting.length;
}
function qLeave_(q,name){
  /* also drop from the waiting list, so a waiter who leaves the queue is removed too */
  q.waiting = q.waiting.filter(function(x){return x.name!==name;});
  if(q.pendingOffer===name) q.pendingOffer = q.waiting.length ? q.waiting[0].name : null;
  if(q.holder!==name) return null;
  q.holder=null; q.holderSince=null; q.holderHeartbeat=null;
  q.pendingOffer = q.waiting.length ? q.waiting[0].name : null;
  return q.pendingOffer;
}
function qDecline_(q,name){
  var who=name||q.pendingOffer; if(!who) return null;
  q.waiting=q.waiting.filter(function(x){return x.name!==who;});
  q.pendingOffer=q.waiting.length?q.waiting[0].name:null;
  return q.pendingOffer;
}
function qAccept_(q,name){
  var who=name||q.pendingOffer; if(!who) return null;
  q.waiting=q.waiting.filter(function(x){return x.name!==who;});
  q.holder=who; q.holderSince=new Date().toISOString(); q.holderHeartbeat=new Date().toISOString();
  q.pendingOffer=null; return who;
}
function qForceRelease_(q){
  var released=q.holder;
  q.holder=null; q.holderSince=null; q.holderHeartbeat=null;
  q.pendingOffer=q.waiting.length?q.waiting[0].name:null;
  return released;
}

/* ---- session rows ---- */
function openSession_(name){
  /* if this user already has an ACTIVE row (page refresh, re-login), reuse it
     instead of opening a second one */
  var s=sheet_("Sessions"); var last=s.getLastRow();
  if(last>=2){
    var vals=s.getRange(2,1,last-1,10).getValues();
    for(var i=vals.length-1;i>=0;i--){
      if(vals[i][1]===name && vals[i][9]==="ACTIVE") return vals[i][0];
    }
  }
  var id=name.replace(/\s+/g,"").slice(0,6).toUpperCase()+"-"+
    Utilities.formatDate(new Date(),Session.getScriptTimeZone(),"yyyyMMdd-HHmmss");
  s.appendRow([id,name,new Date(),"","","",0,0,0,"ACTIVE"]);
  return id;
}
function closeSession_(name,durationMin,jds,proposals,copies){
  var s=sheet_("Sessions"); var last=s.getLastRow(); if(last<2) return;
  var vals=s.getRange(2,1,last-1,10).getValues();
  for(var i=vals.length-1;i>=0;i--){
    if(vals[i][1]===name && vals[i][9]==="ACTIVE"){
      var row=i+2; var login=vals[i][2]; var now=new Date();
      var dmin=(typeof durationMin==="number"&&durationMin>=0)?durationMin
               :(login instanceof Date?Math.round((now-login)/60000):"");
      s.getRange(row,4,1,7).setValues([[now,dmin,hm_(dmin||0),jds||0,proposals||0,copies||0,"CLOSED"]]);
      return dmin;
    }
  }
  s.appendRow(["(auto)",name,"",new Date(),durationMin||"",hm_(durationMin||0),jds||0,proposals||0,copies||0,"CLOSED"]);
  return durationMin;
}

/* ---- Claude proxy (fallback only — the app normally uses the /api/claude Vercel proxy) ----
   Output rules mirror CLAUDE.md: full proposal AND full cover letter, no placeholders,
   no em dashes or en dashes, no invented metrics. */
var SYSTEM_PROMPT = [
  "You are the proposal co-pilot for Saqib Shahzad, a senior AI and ML consultant on Upwork. His posted profile rate is $85.00/hr. Bid floor is $85/hr, never quote below the posted rate. Standard bid band is $85-110/hr, set per job by Saqib and Usman.",
  "Saqib is Rising Talent with 100% Job Success. He is NOT Top Rated. Never claim a badge or credential that is not on his live profile.",
  "Write every proposal following Saqib's 5-point formula EXACTLY:",
  "1. HOOK: open with the client's exact problem, using 2 or 3 of their own words. Never open with 'Hi, I am Saqib', 'Dear Hiring Manager', or 'I am the perfect fit'.",
  "2. PROOF: one or two proof points that are TRUE of Saqib. If you do not know a real number, write a true qualitative sentence instead. NEVER write a bracketed blank, a placeholder, or an invented metric, employer, title, or credential.",
  "3. PLAN: a 2 to 3 step plan specific to this job's actual scope and deliverables.",
  "4. QUESTION: one sharp question about this specific project. Not generic. It should show you read the post.",
  "5. CTA: one natural closing sentence. No 'Best regards', no 'Sincerely'.",
  "Hard rules: proposal is 120 to 180 words. NEVER use em dashes or en dashes. Use commas and periods. Natural, humanized, spoken English.",
  "Also write a COVER LETTER of 2 to 4 sentences, complete and ready to paste. Same rules: no placeholders, no em dashes, nothing invented.",
  "Both outputs must be finished text a human can paste without editing. Return ONLY valid JSON, no markdown and no code fences:",
  "{\"proposal\":\"...\",\"cover\":\"...\"}"
].join("\n");

function callClaude_(prompt, systemOverride, messageOverride, modelOverride, maxTokensOverride){
  var key=PropertiesService.getScriptProperties().getProperty("CLAUDE_API_KEY");
  if(!key) return {ok:false,error:"CLAUDE_API_KEY not set. Apps Script -> Project Settings -> Script Properties.",text:null};
  var model=modelOverride||PropertiesService.getScriptProperties().getProperty("CLAUDE_MODEL")||"claude-sonnet-4-6";
  var sysPrompt=systemOverride||SYSTEM_PROMPT;
  var userContent=messageOverride||prompt||"";
  var maxTok=maxTokensOverride||1200;
  try{
    var res=UrlFetchApp.fetch("https://api.anthropic.com/v1/messages",{
      method:"post",contentType:"application/json",muteHttpExceptions:true,
      headers:{"x-api-key":key,"anthropic-version":"2023-06-01"},
      payload:JSON.stringify({model:model,max_tokens:maxTok,system:sysPrompt,
        messages:[{role:"user",content:userContent}]})
    });
    var j=JSON.parse(res.getContentText());
    if(j.error) return {ok:false,error:j.error.message||JSON.stringify(j.error),text:null};
    var text=j&&j.content&&j.content[0]?j.content[0].text:null;
    return {ok:!!text,text:text};
  }catch(e){
    return {ok:false,error:"Fetch error: "+String(e),text:null};
  }
}

/* ---- logs out ---- */
function logsOut_(){
  var s=sheet_("ActivityLog"); var last=s.getLastRow(); var out=[];
  if(last>=2){
    var rows=s.getRange(2,1,last-1,13).getValues();
    out=rows.map(function(r){return {ts:r[0],user:r[1],type:r[2],decision:r[3],client:r[4],job:r[5],
      match:r[6],total:r[7],country:r[8],budget:r[9],durationMin:r[10],detail:r[11],summary:r[12]};})
      .reverse().slice(0,300);
  }
  return out;
}
function json_(o){return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);}

/* ---- routing ---- */
/* Gate mutations run under a script lock. Without it, two people hitting "Enter"
   at the same moment both read holder=null and both become holder. */
var GATE_ACTIONS = {login:1, logout:1, heartbeat:1, gateAccept:1, gateDecline:1, forceRelease:1};

function handle_(data){
  var action=data.action||"", name=data.name||(data.entry&&data.entry.user)||"";

  if(action==="log"){
    var e=data.entry||{};
    sheet_("ActivityLog").appendRow([new Date(),(e.user||name||""),e.type||"",e.decision||"",
      e.client||"",e.job||"",e.match||"",e.total||e.score||"",e.country||"",(e.budget!=null?e.budget:""),
      (e.durationMin!=null?e.durationMin:""),e.detail||"",e.summary||""]);
    return {ok:true};
  }
  if(action==="getLogs") return {ok:true,logs:logsOut_(),gate:readQueue_()};
  if(action==="claude")  return callClaude_(data.prompt||"", data.system, data.message, data.model, data.max_tokens);
  if(action==="logCLEval"){
    var d=data.row||{};
    var ts=new Date();
    var tz="Asia/Karachi";
    sheet_("CLEval").appendRow([
      d.assignee||name||"",
      Utilities.formatDate(ts,tz,"yyyy-MM-dd"),
      Utilities.formatDate(ts,tz,"HH:mm:ss"),
      d.jobTitle||"", d.jobLink||"",
      d.hiringRate||"", d.clientRatings||"", d.payVerified||"",
      d.totalSpend||"", d.proposals||"", d.interviewing||"", d.invitesSent||"", d.unansweredInvites||"",
      d.flag||"", d.applied||"", d.fixedHourly||"",
      d.highBid||"", d.avgBid||"", d.lowBid||"",
      d.connects||"6", d.bid||"$85/hr", d.reason||"", d.jobPosted||"", d.openJobs||""
    ]);
    return {ok:true};
  }
  if(!GATE_ACTIONS[action]) return {ok:true,note:"no-op"};

  var lock=LockService.getScriptLock();
  try{ lock.waitLock(LOCK_MS); }
  catch(e){ return {ok:false,error:"Gate is busy, try again in a moment."}; }

  try{
    var q=readQueue_();

    if(action==="login"){
      var st=qJoin_(q,name); writeQueue_(q); openSession_(name);
      return {ok:true,gate:q,gateStatus:st};
    }
    if(action==="logout"){
      var promoted=qLeave_(q,name); writeQueue_(q);
      var dmin=closeSession_(name,data.durationMin,data.jds,data.proposals,data.copies);
      return {ok:true,gate:q,promoted:promoted,durationMin:dmin};
    }
    if(action==="heartbeat"){
      if(q.holder===name){q.holderHeartbeat=new Date().toISOString();writeQueue_(q);}
      return {ok:true,gate:q};
    }
    if(action==="gateAccept")  {qAccept_(q,name);  writeQueue_(q); return {ok:true,gate:q};}
    if(action==="gateDecline") {qDecline_(q,name); writeQueue_(q); return {ok:true,gate:q};}
    if(action==="forceRelease"){
      if(ADMINS.indexOf(name)===-1) return {ok:false,error:"Admin only (Saqib or Zeb)"};
      var released=qForceRelease_(q); writeQueue_(q);
      sheet_("ActivityLog").appendRow([new Date(),name,"FORCE_RELEASE","","","","","","","","",
        "Admin "+name+" force-released "+(released||"(nobody)"),""]);
      return {ok:true,gate:q,released:released};
    }
    return {ok:true,note:"no-op"};
  } finally {
    lock.releaseLock();
  }
}

function doPost(e){
  var data={}; try{data=JSON.parse(e.postData.contents);}catch(err){data={};}
  return json_(handle_(data));
}
/* GET is read-only. Gate mutations must go through POST so a stray link cannot
   release someone's seat. */
function doGet(e){
  var p=(e&&e.parameter)||{};
  if(GATE_ACTIONS[p.action]) return json_({ok:false,error:"This action requires POST."});
  return json_(handle_(p));
}
