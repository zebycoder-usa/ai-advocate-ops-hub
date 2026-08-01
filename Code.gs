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
  Queue:       ["Holder","HolderSince","Waiting","PendingOffer","UpdatedAt","HolderHeartbeat","Admins"],
  CLEval:      ["Assignee","Date","Time PKT","Job Title","Job Link","Hiring Rate","Client Ratings","Payment Method Verified?","Total Spend","Proposals","Interviewing","Invites sent","Unanswered Invites","Flag","Applied?","Fixed/ Hourly","High Bid","Avg. Bid","Low bid","No. of Connects","Bid","Reason/Remarks","Job posted","Open jobs","Ptoposal Status"],
  _Idempotency:["evaluationId","status","rowNumber","updatedAt"],
  /* Full history of every proposal-status change. Deliberately a separate tab:
     CLEval must stay exactly 25 columns to match the format the team already
     uses, and a single "updated at" cell would throw away the timeline. Keeping
     every change is what makes time-to-reply and time-to-hire computable. */
  _StatusLog:  ["evaluationId","status","at","by"],
  /* Every field edit, so a shared sheet never changes silently. */
  _RowLog:     ["evaluationId","row","field","from","to","at","by"]
};

/* Owner decision, 31 July 2026: admins are Usman, Saqib and Waqas. Jahanzaib
   (Zeb) is no longer an admin. Must match SEAT_ADMINS in index.html. */
var ADMINS   = ["Usman Saeed","Saqib Shahzad","Waqas Riaz"];
/* Statuses a proposal can be in. "Un Opened" is the LEGACY value sitting in 664
   existing rows: it is accepted on read and means the same as "Not checked",
   which is deliberately distinct from "No response". Those were the same word
   before, so a reply rate could not be calculated at all. */
var CLEVAL_STATUSES = ["Not checked","No response","Opened","Replied","Interview","Hired","Lost"];
var LEGACY_STATUS   = "Un Opened";
var STALE_MS = 12 * 60 * 1000; // 12 min without heartbeat -> auto-release
var LOCK_MS  = 10 * 1000;      // how long to wait for the gate lock

/* ---- sheet helpers ---- */
function ss_()  { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name){
  var s = ss_().getSheetByName(name);
  if(!s){ s = ss_().insertSheet(name); s.appendRow(TABS[name]||["Timestamp","Data"]); s.setFrozenRows(1); }
  return s;
}
function setup(){ Object.keys(TABS).forEach(function(n){ sheet_(n); }); var id=ss_().getSheetByName("_Idempotency"); if(id) id.hideSheet(); readQueue_(); return "setup ok"; }
function hm_(min){ min=Math.round(min||0); var h=Math.floor(min/60),m=min%60; return h+"h "+m+"m"; }

/* ---- queue I/O ---- */
/* allowRelease: only a caller holding the script lock may trigger the stale-holder
   auto-release, because that path WRITES (queue + ActivityLog). Reading the queue
   must never mutate it. getLogs is reachable over GET, so with the release wired
   into the read a stray link, a prefetch or a crawler could take the seat away
   from whoever was mid-bid, and it ran outside the lock, racing every other
   transition. The stale holder is now released on the next real gate action,
   which is precisely when it matters. */
function readQueue_(allowRelease){
  var s = sheet_("Queue");
  if(s.getLastRow()<2){ s.appendRow(["","","","",new Date(),"",""]); }
  var r = s.getRange(2,1,1,7).getValues()[0];
  var waiting = r[2] ? String(r[2]).split(" || ").filter(String).map(function(x){
    var p=x.split("|"); return {name:p[0],bookedAt:p[1]||""}; }) : [];
  /* Admins present, tracked SEPARATELY from the holder. They do not bid, so they
     never take the seat and never displace whoever is bidding. */
  var admins = r[6] ? String(r[6]).split(" || ").filter(String) : [];
  var q = {holder:r[0]||null,holderSince:r[1]||null,waiting:waiting,pendingOffer:r[3]||null,holderHeartbeat:r[5]||null,admins:admins};

  /* auto-release a holder who stopped sending heartbeats (crashed tab, closed laptop) */
  if(allowRelease && q.holder && q.holderHeartbeat){
    var lastHb = new Date(q.holderHeartbeat).getTime();
    if(!isNaN(lastHb) && (Date.now()-lastHb)>STALE_MS){
      var staleHolder = q.holder;
      q.holder=null; q.holderSince=null; q.holderHeartbeat=null;
      q.pendingOffer = q.waiting.length ? q.waiting[0].name : null;
      writeQueue_(q);
      closeSession_(staleHolder,null,0,0,0,"TIMED OUT");
      sheet_("ActivityLog").appendRow([new Date(),staleHolder,"AUTO_RELEASE","","","","","","","","",
        "Auto-released after 12 min inactivity (heartbeat timeout).",""]);
    }
  }
  return q;
}
function writeQueue_(q){
  var s=sheet_("Queue");
  if(s.getLastRow()<2) s.appendRow(["","","","",new Date(),"",""]);
  var w=(q.waiting||[]).map(function(x){return x.name+"|"+(x.bookedAt||"");}).join(" || ");
  var a=(q.admins||[]).join(" || ");
  s.getRange(2,1,1,7).setValues([[q.holder||"",q.holderSince||"",w,q.pendingOffer||"",new Date(),q.holderHeartbeat||"",a]]);
  return q;
}
function isAdmin_(name){ return ADMINS.indexOf(name)>=0; }

/* ---- gate transitions ---- */
function qJoin_(q,name){
  /* Admins never queue and never wait. They also never take the seat, because
     they do not bid: they are simply present. So an admin joining leaves the
     holder, the pending offer and the waiting list completely untouched, and a
     bidder can still claim an empty seat while admins are in. */
  if(isAdmin_(name)){
    q.admins=q.admins||[];
    if(q.admins.indexOf(name)<0) q.admins.push(name);
    return "ADMIN";
  }
  if(!q.holder){
    q.holder=name; q.holderSince=new Date().toISOString(); q.holderHeartbeat=new Date().toISOString();
    /* Filling the seat cancels any outstanding offer, and the new holder must
       not also sit in the waiting list. A pendingOffer that outlives the seat
       being filled is a redeemable token: the stale offeree can later accept
       and take the profile from whoever is now bidding on it. */
    q.pendingOffer=null;
    q.waiting=q.waiting.filter(function(x){return x.name!==name;});
    return "HOLDER";
  }
  if(q.holder===name){ q.holderHeartbeat=new Date().toISOString(); return "HOLDER"; }
  if(q.waiting.some(function(x){return x.name===name;})) return "ALREADY_WAITING";
  q.waiting.push({name:name,bookedAt:new Date().toISOString()});
  return "WAITING#"+q.waiting.length;
}
function qLeave_(q,name){
  /* An admin leaving only removes their presence. They were never the holder and
     were never in the waiting list, so nothing else may move. */
  if(isAdmin_(name)){
    q.admins=(q.admins||[]).filter(function(x){return x!==name;});
    return null;
  }
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
  /* An accept is valid ONLY from the person actually offered the seat, and only
     while the seat is free. Without these two guards any caller could POST
     {action:'gateAccept',name:'X'} and evict whoever was mid-bid, even having
     never logged in or queued. Both checks sit above the waiting-list filter so
     a refused accept mutates nothing: it must not consume the rightful
     offeree's turn or drop the caller out of the line. */
  if(q.pendingOffer!==who) return null;
  if(q.holder) return null;
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
/* status defaults to CLOSED. The stale auto-release passes TIMED OUT, so a
   session that simply vanished is distinguishable from a clean sign-out: the
   logout time on a timed-out row is when we NOTICED, not when they left. */
function closeSession_(name,durationMin,jds,proposals,copies,status){
  var s=sheet_("Sessions"); var last=s.getLastRow(); if(last<2) return;
  var vals=s.getRange(2,1,last-1,10).getValues();
  for(var i=vals.length-1;i>=0;i--){
    if(vals[i][1]===name && vals[i][9]==="ACTIVE"){
      var row=i+2; var login=vals[i][2]; var now=new Date();
      var dmin=(typeof durationMin==="number"&&durationMin>=0)?durationMin
               :(login instanceof Date?Math.round((now-login)/60000):"");
      s.getRange(row,4,1,7).setValues([[now,dmin,hm_(dmin||0),jds||0,proposals||0,copies||0,status||"CLOSED"]]);
      return dmin;
    }
  }
  s.appendRow(["(auto)",name,"",new Date(),durationMin||"",hm_(durationMin||0),jds||0,proposals||0,copies||0,status||"CLOSED"]);
  return durationMin;
}

/* ---- Claude proxy (fallback only — the app normally uses the /api/claude Vercel proxy) ----
   Output rules mirror CLAUDE.md: full proposal AND full cover letter, no placeholders,
   no em dashes or en dashes, no invented metrics. */
var SYSTEM_PROMPT = [
  "You are the proposal co-pilot for AI Advocate Agency, a full-service tech team; the principal on Upwork is Saqib Shahzad, a senior AI and ML consultant. The agency rate floor is $40/hr and above, set per job (matches the app's /api/claude AGENCY_CONTEXT). Never quote below $40/hr. Do not state a specific rate unless the job post or the user provides one.",
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

/* ============================ CLEval (25-col, idempotent, injection-safe) ====
   Writes all 25 columns in TABS.CLEval order. Assignee, Date (M/d/yyyy),
   Time PKT (HH:mm Asia/Karachi) and the default "Ptoposal Status" are set here
   server-side, never trusted from the browser. */
/* Field name per CLEval column, in column order. MUST stay aligned with
   TABS.CLEval above and with CLEVAL_COLUMNS in index.html: the three are one
   contract split across two files, and a mismatch writes to the wrong column. */
var CLEVAL_FIELDS = ["assignee", "date", "timePkt", "jobTitle", "jobLink", "hiringRate", "clientRatings", "payVerified", "totalSpend", "proposals", "interviewing", "invitesSent", "unansweredInvites", "flag", "applied", "fixedHourly", "highBid", "avgBid", "lowBid", "connects", "bid", "reason", "jobPosted", "openJobs", "proposalStatus"];
var CLEVAL_ALLOWED_TABS = {"CLEval":1, "CLEval_StagingTest":1}; /* destination fixed; only these are writable */
function resolveCLEvalSheet_(name){
  return sheet_((name && CLEVAL_ALLOWED_TABS[name]) ? name : "CLEval");
}
/* Neutralize a leading formula trigger so a pasted title/reason cannot execute. */
function neutralizeCell_(v){
  if(v==null) return "";
  if(typeof v==="string" && /^[=+\-@]/.test(v)) return "'"+v;
  return v;
}
function isUpworkHttps_(u){
  return typeof u==="string" && /^https:\/\/([a-z0-9-]+\.)*upwork\.com\//i.test(u);
}
/* Build the 25 cells in header order. Server-owned fields override the browser. */
function clevalServerRow_(d, actor){
  d = d || {};
  var tz="Asia/Karachi", ts=new Date();
  var link = isUpworkHttps_(d.jobLink) ? d.jobLink : "";  /* rich-text "URL" link applied after append */
  var cells = [
    actor || d.assignee || "",                       /* 1  Assignee (server-owned) */
    Utilities.formatDate(ts,tz,"M/d/yyyy"),          /* 2  Date (server-owned) */
    Utilities.formatDate(ts,tz,"HH:mm"),             /* 3  Time PKT (server-owned) */
    d.jobTitle||"",                                  /* 4  Job Title */
    link?"URL":"-",                                  /* 5  Job Link -> clickable "URL" (link attached below) */
    d.hiringRate||"", d.clientRatings||"", d.payVerified||"",           /* 6-8 */
    d.totalSpend||"", d.proposals||"", d.interviewing||"",              /* 9-11 */
    d.invitesSent||"", d.unansweredInvites||"",                         /* 12-13 */
    d.flag||"", d.applied||"", d.fixedHourly||"",                       /* 14-16 */
    d.highBid||"", d.avgBid||"", d.lowBid||"",                          /* 17-19 */
    d.connects||"", d.bid||"", d.reason||"",                            /* 20-22 */
    d.jobPosted||"", d.openJobs||"",                                    /* 23-24 */
    "Un Opened"                                      /* 25 Ptoposal Status (server-owned default) */
  ];
  return cells.map(neutralizeCell_);
}
/* ---- idempotency ledger (hidden _Idempotency tab) ---- */
function idemFind_(evId){
  var s=sheet_("_Idempotency"), last=s.getLastRow();
  if(last<2) return null;
  var vals=s.getRange(2,1,last-1,3).getValues();
  for(var i=vals.length-1;i>=0;i--){ if(String(vals[i][0])===String(evId)) return {row:i+2,status:vals[i][1],rowNumber:vals[i][2]}; }
  return null;
}
function idemSet_(evId,status,rowNumber){
  var s=sheet_("_Idempotency"), found=idemFind_(evId);
  if(found) s.getRange(found.row,2,1,3).setValues([[status, rowNumber||found.rowNumber||"", new Date()]]);
  else s.appendRow([evId,status,rowNumber||"", new Date()]);
}
/* Serialized reserve+append+commit. A retry with the same evaluationId returns
   the existing row instead of duplicating (survives a mid-write crash). */
function handleLogCLEval_(data, name){
  /* Shared-secret gate. Reads Script Property LOG_SECRET and accepts ONLY an
     exact match. Fail-closed: if LOG_SECRET is unset, or the request's secret is
     missing/wrong, reject with {ok:false,error:'unauthorized'} and write nothing.
     Only postCLEval() calls this, and it sends secret:CLEVAL_SECRET. */
  var want=PropertiesService.getScriptProperties().getProperty('LOG_SECRET');
  if(!want || !data || data.secret!==want) return {ok:false,error:'unauthorized'};
  var evId = data.evaluationId || (data.row && data.row.evaluationId) || "";
  var lock=LockService.getScriptLock();
  try{ lock.waitLock(LOCK_MS); } catch(e){ return {ok:false,error:"CLEval busy, try again in a moment."}; }
  try{
    var sheet=resolveCLEvalSheet_(data.sheet);
    if(evId){
      var ex=idemFind_(evId);
      if(ex && String(ex.status)==="COMMITTED" && ex.rowNumber) return {ok:true,row:ex.rowNumber,deduped:true};
      if(ex && ex.rowNumber){ idemSet_(evId,"COMMITTED",ex.rowNumber); return {ok:true,row:ex.rowNumber,deduped:true}; }
      /* Reserve the DESTINATION ROW before appending. This was written as PENDING
         with an empty rowNumber, so a crash between the append below and the
         COMMITTED write left a row on the sheet that the ledger could not point
         at. The recovery guard above tests ex.rowNumber, which was "", so the
         retry fell straight through and appended a duplicate: the exact crash
         the ledger exists to survive. */
      idemSet_(evId,"PENDING",sheet.getLastRow()+1);
    }
    var row=clevalServerRow_(data.row||{}, name);
    sheet.appendRow(row);
    var rowNumber=sheet.getLastRow();
    var link=(data.row||{}).jobLink;
    if(isUpworkHttps_(link)){
      var rt=SpreadsheetApp.newRichTextValue().setText("URL").setLinkUrl(link).build();
      sheet.getRange(rowNumber,5).setRichTextValue(rt);   /* clickable "URL"; NEVER a =HYPERLINK() string */
    }
    if(evId) idemSet_(evId,"COMMITTED",rowNumber);
    return {ok:true,row:rowNumber,deduped:false};
  } finally { lock.releaseLock(); }
}
/* Turns "2026-07-15" or "7/15/2026" or a real Date into a comparable YYYYMMDD
   integer. Deliberately avoids Date parsing for the two string shapes, because
   that is where the timezone skew came from. */
function dayNum_(v){
  if(v==null || v==='') return NaN;
  var s=String(v).trim(), m;
  if((m=/^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)))   return (+m[1])*10000+(+m[2])*100+(+m[3]);
  if((m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s))) return (+m[3])*10000+(+m[1])*100+(+m[2]);
  var d=new Date(s);
  return isNaN(d.getTime()) ? NaN : d.getFullYear()*10000+(d.getMonth()+1)*100+d.getDate();
}

/* ---- read the session history back ----
   Who signed in when, and when they signed out. The Sessions sheet has been
   written since v11 and nothing could ever read a row of it. READ ONLY: no lock,
   no writes, and deliberately readQueue_ is NOT called, so listing sessions can
   never trigger the stale auto-release. */
function handleListSessions_(data){
  var want=PropertiesService.getScriptProperties().getProperty('LOG_SECRET');
  if(!want || !data || data.secret!==want) return {ok:false,error:'unauthorized'};
  var s=sheet_("Sessions"), last=s.getLastRow();
  if(last<2) return {ok:true,headers:TABS.Sessions.slice(),rows:[],total:0};

  var limit=Math.min(Math.max(parseInt(data.limit,10)||500,1),2000);
  var all=s.getRange(2,1,last-1,TABS.Sessions.length).getValues();

  /* Login Time is column 3. Calendar-day comparison, for the same reason
     listCLEval needs one: an ISO date parsed as UTC against a local-midnight
     cell drops every row dated exactly on the boundary. */
  if(data.since){
    var fromDay=dayNum_(data.since);
    if(!isNaN(fromDay)) all=all.filter(function(r){ var d=dayNum_(r[2]); return !isNaN(d) && d>=fromDay; });
  }
  var total=all.length;
  return {ok:true,headers:TABS.Sessions.slice(),rows:all.slice(Math.max(0,total-limit)),total:total};
}

/* ---- read the job history back ----
   The app could write CLEval rows and never read one. Without this there is no
   filterable list, no duplicate check, and no way to record what happened after
   a bid. READ ONLY: no lock, no writes, nothing released. */
function handleListCLEval_(data){
  var want=PropertiesService.getScriptProperties().getProperty('LOG_SECRET');
  if(!want || !data || data.secret!==want) return {ok:false,error:'unauthorized'};
  var s=resolveCLEvalSheet_(data.sheet), last=s.getLastRow();
  if(last<2) return {ok:true,headers:TABS.CLEval.slice(),rows:[],total:0};

  var limit=Math.min(Math.max(parseInt(data.limit,10)||500,1),2000);
  var all=s.getRange(2,1,last-1,TABS.CLEval.length).getValues();

  /* Job Link is written as a rich-text cell whose DISPLAY TEXT is the word "URL"
     and whose link carries the real address, so the sheet stays in the format the
     team already reads. getValues() returns display text, so every Job Link came
     back here as the literal string "URL": findDuplicateJob then extracted a job
     id from "URL", found none, and could never match. Duplicate detection was
     dead from the day it shipped and no test could see it, because the test mock
     handed back the whole rich-text object instead of the display text.
     Recover the real address from the link, and leave a cell that was written as
     plain text exactly as it is. */
  var linkCol=TABS.CLEval.indexOf('Job Link');
  if(linkCol>=0){
    /* Recovering the link is an improvement on the row, not a precondition for
       returning it. If this throws, the history still comes back with "URL" in the
       link column, which is the old behaviour: duplicate detection stays blind but
       All Jobs still loads. Taking the whole history read down to save a hyperlink
       would be a bad trade. */
    try{
      var rng=s.getRange(2,linkCol+1,last-1,1);
      var rich=rng.getRichTextValues ? rng.getRichTextValues() : null;
      if(rich){
        for(var i=0;i<all.length;i++){
          var cell=rich[i] && rich[i][0];
          var u=(cell && cell.getLinkUrl) ? cell.getLinkUrl() : null;
          if(u) all[i][linkCol]=u;
        }
      }
    }catch(e){ /* keep the display text */ }
  }

  /* since filters on the Date column (2), so the client can pull just this week.
     Compared by CALENDAR DAY, never by timestamp. data.since arrives as ISO
     ("2026-07-15"), which Date parses as UTC midnight, while the Date column
     holds "M/d/yyyy" written in Asia/Karachi, which Date parses as LOCAL
     midnight. On the live script at UTC+5 that puts a same-day row five hours
     BEFORE the cutoff, so every row dated exactly on the since day was silently
     dropped. Invisible on a laptop with a negative UTC offset, which is exactly
     the kind of bug that reaches production. */
  if(data.since){
    var fromDay=dayNum_(data.since);
    if(!isNaN(fromDay)){
      all=all.filter(function(r){ var d=dayNum_(r[1]); return !isNaN(d) && d>=fromDay; });
    }
  }
  var total=all.length;
  var rows=all.slice(Math.max(0,total-limit));   /* newest window, oldest first */
  return {ok:true,headers:TABS.CLEval.slice(),rows:rows,total:total};
}

/* ---- record what happened after the bid ----
   Every write until now appended. This edits column 25 of a row that already
   exists, found through the idempotency ledger, and appends the change to
   _StatusLog so the timeline survives. */
function handleUpdateCLEvalStatus_(data, actor){
  var want=PropertiesService.getScriptProperties().getProperty('LOG_SECRET');
  if(!want || !data || data.secret!==want) return {ok:false,error:'unauthorized'};

  var evId=String(data.evaluationId||'');
  if(!evId) return {ok:false,error:'evaluationId is required'};

  var status=String(data.status||'');
  if(CLEVAL_STATUSES.indexOf(status)<0) return {ok:false,error:'unknown status: '+status};

  var lock=LockService.getScriptLock();
  try{ lock.waitLock(LOCK_MS); } catch(e){ return {ok:false,error:'CLEval busy, try again in a moment.'}; }
  try{
    var ex=idemFind_(evId);
    if(!ex || !ex.rowNumber) return {ok:false,error:'unknown evaluationId'};
    var s=resolveCLEvalSheet_(data.sheet);
    var row=parseInt(ex.rowNumber,10);
    if(!(row>1) || row>s.getLastRow()) return {ok:false,error:'unknown evaluationId'};

    s.getRange(row, TABS.CLEval.length).setValue(status);   /* column 25 only */
    sheet_("_StatusLog").appendRow([evId,status,new Date(),actor||'']);
    return {ok:true,row:row,status:status};
  } finally { lock.releaseLock(); }
}

/* Edit any column on an existing row.
   =====================================================================
   Addressing is the whole problem here. updateCLEvalStatus finds its row through
   the _Idempotency ledger, which only has entries for rows the APP wrote. The
   hundreds of rows the team typed by hand have no ledger entry at all, so every
   one of them answers "unknown evaluationId" and cannot be touched. An edit
   feature that only works on rows nobody needs to edit is no feature.

   So this accepts a row NUMBER as well, and guards it. Row numbers drift when
   anyone inserts or deletes a line in the sheet, and a drifted write would
   silently overwrite somebody else's job. The client must therefore send the job
   title it believes is on that row, and the write is refused if it does not
   match. Wrong row is a far worse outcome than a refused edit. */
function handleUpdateCLEvalRow_(data, actor){
  var want=PropertiesService.getScriptProperties().getProperty('LOG_SECRET');
  if(!want || !data || data.secret!==want) return {ok:false,error:'unauthorized'};
  var patch=data.row;
  if(!patch || typeof patch!=='object') return {ok:false,error:'row is required'};

  var lock=LockService.getScriptLock();
  try{ lock.waitLock(LOCK_MS); } catch(e){ return {ok:false,error:'CLEval busy, try again in a moment.'}; }
  try{
    var s=resolveCLEvalSheet_(data.sheet), last=s.getLastRow();
    var row=0;

    var evId=String(data.evaluationId||'');
    if(evId){ var ex=idemFind_(evId); if(ex && ex.rowNumber) row=parseInt(ex.rowNumber,10); }
    if(!row && data.rowNumber) row=parseInt(data.rowNumber,10);
    if(!(row>1) || row>last) return {ok:false,error:'row not found'};

    /* The guard. expectTitle is what the client saw when it opened the editor. */
    var titleCol=TABS.CLEval.indexOf('Job Title')+1;
    if(data.expectTitle!==undefined && titleCol>0){
      var actual=String(s.getRange(row,titleCol).getDisplayValue()||'').trim();
      if(actual!==String(data.expectTitle||'').trim()){
        return {ok:false,error:'row moved, reload before editing',expected:data.expectTitle,found:actual};
      }
    }

    var byField={};
    CLEVAL_FIELDS.forEach(function(f,i){ byField[f]=i+1; });   /* field -> column */

    var changed=[];
    Object.keys(patch).forEach(function(f){
      var c=byField[f]; if(!c) return;                          /* unknown field, ignore */
      var v=patch[f];
      if(f==='proposalStatus' && CLEVAL_STATUSES.indexOf(String(v))<0) return;  /* keep the vocabulary closed */
      var before=String(s.getRange(row,c).getDisplayValue()||'');
      if(f==='jobLink'){
        /* Keep the team's clickable "URL" format rather than dumping a raw link
           into a sheet everyone reads. */
        if(isUpworkHttps_(v)){
          s.getRange(row,c).setRichTextValue(
            SpreadsheetApp.newRichTextValue().setText("URL").setLinkUrl(String(v)).build());
        } else s.getRange(row,c).setValue(neutralizeCell_(v));
      } else {
        s.getRange(row,c).setValue(neutralizeCell_(v));
      }
      var after=String(v==null?'':v);
      if(before!==after) changed.push({field:f,from:before,to:after});
    });

    /* Every edit is recorded. A shared sheet with silent edits is a sheet nobody
       can trust, and "who changed this and when" is the first question asked. */
    if(changed.length){
      var log=sheet_("_RowLog");
      changed.forEach(function(c){ log.appendRow([evId||('row'+row), row, c.field, c.from, c.to, new Date(), actor||'']); });
    }
    return {ok:true,row:row,changed:changed.length,fields:changed.map(function(c){return c.field;})};
  } finally { lock.releaseLock(); }
}

/* On-demand 24->25 header repair. Idempotent: no-op once headers already match.
   Run on the STAGING clone first; existing rows keep their first 24 values and
   get a blank 25th column. */
function repairCLEvalHeaders(){
  var s=sheet_("CLEval"), want=TABS.CLEval;
  var width=Math.max(s.getLastColumn(), want.length);
  var have=width>=1 ? s.getRange(1,1,1,width).getValues()[0] : [];
  var same = want.every(function(h,i){ return String(have[i]||"")===h; });
  if(same) return "CLEval headers already 25-col; no change.";
  s.getRange(1,1,1,want.length).setValues([want]);
  s.setFrozenRows(1);
  return "CLEval headers repaired to 25 columns.";
}

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
  if(action==="logCLEval") return handleLogCLEval_(data, name);
  if(action==="listCLEval") return handleListCLEval_(data);
  if(action==="listSessions") return handleListSessions_(data);
  if(action==="updateCLEvalStatus") return handleUpdateCLEvalStatus_(data, name);
  if(action==="updateCLEvalRow") return handleUpdateCLEvalRow_(data, name);
  if(!GATE_ACTIONS[action]) return {ok:true,note:"no-op"};

  var lock=LockService.getScriptLock();
  try{ lock.waitLock(LOCK_MS); }
  catch(e){ return {ok:false,error:"Gate is busy, try again in a moment."}; }

  try{
    /* true: we hold the lock here, so this is the one place allowed to run the
       stale-holder auto-release, which writes. */
    var q=readQueue_(true);

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
      if(ADMINS.indexOf(name)===-1) return {ok:false,error:"Admin only"};
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
/* GET is read-only. Gate mutations AND all writes / model calls must go through
   POST so a stray link or prefetch cannot release a seat, write a CLEval row, or
   spend Claude tokens (R4). Only genuinely read-only actions may run on GET. */
var POST_ONLY = {login:1, logout:1, heartbeat:1, gateAccept:1, gateDecline:1, forceRelease:1,
                 log:1, claude:1, logCLEval:1, listCLEval:1, updateCLEvalStatus:1, updateCLEvalRow:1, listSessions:1};
function doGet(e){
  var p=(e&&e.parameter)||{};
  if(POST_ONLY[p.action]) return json_({ok:false,error:"This action requires POST."});
  return json_(handle_(p));
}
