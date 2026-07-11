/* ============================================================================
   AI ADVOCATE v10 — Google Apps Script backend (FREE)
   Fixes: User name now recorded on EVERY row. Adds session Duration (min & h:m),
   Login/Logout timestamps, and richer JD columns.

   SETUP (5 min):
   1. New Google Sheet -> Extensions > Apps Script -> paste this file -> Save.
   2. Project Settings > Script Properties:
        CLAUDE_API_KEY = sk-ant-...      (your Anthropic key)
        CLAUDE_MODEL   = claude-sonnet-4-5   (optional)
   3. Deploy > New deployment > Web app: Execute as Me, Access Anyone. Copy /exec URL.
   4. Paste that URL into index.html -> BACKEND_URL. Run setup() once (optional).
============================================================================ */

var TABS = {
  ActivityLog:["Timestamp","User","Type","Decision","Client","Job","Match","Total /19","Country","Budget","Duration (min)","Detail","Summary"],
  Sessions:   ["Session ID","User","Login Time","Logout Time","Duration (min)","Duration (h:m)","JDs","Proposals","Copies","Status"],
  Queue:      ["Holder","HolderSince","Waiting (name|bookedAt ...)","PendingOffer","UpdatedAt"]
};

function ss(){ return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name){
  var s = ss().getSheetByName(name);
  if(!s){ s = ss().insertSheet(name); s.appendRow(TABS[name]||["Timestamp","Data"]); s.setFrozenRows(1); }
  return s;
}
function setup(){ Object.keys(TABS).forEach(function(n){ sheet_(n); }); readQueue_(); return "ok"; }

function hm_(min){ min=Math.round(min||0); var h=Math.floor(min/60), m=min%60; return h+"h "+m+"m"; }

/* ---------- queue ---------- */
function readQueue_(){
  var s = sheet_("Queue");
  if(s.getLastRow() < 2){ s.appendRow(["","","","",new Date()]); }
  var r = s.getRange(2,1,1,5).getValues()[0];
  var waiting = r[2] ? String(r[2]).split(" || ").filter(String).map(function(x){
    var p=x.split("|"); return {name:p[0], bookedAt:p[1]||""}; }) : [];
  return { holder:r[0]||null, holderSince:r[1]||null, waiting:waiting, pendingOffer:r[3]||null };
}
function writeQueue_(q){
  var s = sheet_("Queue");
  var w = (q.waiting||[]).map(function(x){ return x.name+"|"+(x.bookedAt||""); }).join(" || ");
  s.getRange(2,1,1,5).setValues([[q.holder||"", q.holderSince||"", w, q.pendingOffer||"", new Date()]]);
  return q;
}
function qJoin_(q,name){
  if(!q.holder){ q.holder=name; q.holderSince=new Date().toISOString(); return "HOLDER"; }
  if(q.holder===name) return "HOLDER";
  if(q.waiting.some(function(x){return x.name===name;})) return "ALREADY_WAITING";
  q.waiting.push({name:name,bookedAt:new Date().toISOString()}); return "WAITING#"+q.waiting.length;
}
function qLeave_(q,name){
  if(q.holder!==name) return null;
  q.holder=null; q.holderSince=null;
  if(q.waiting.length){ q.pendingOffer=q.waiting[0].name; return q.pendingOffer; }
  q.pendingOffer=null; return null;
}
function qDecline_(q){
  if(!q.pendingOffer) return null;
  q.waiting=q.waiting.filter(function(x){return x.name!==q.pendingOffer;});
  q.pendingOffer=q.waiting.length? q.waiting[0].name : null; return q.pendingOffer;
}
function qAccept_(q){
  if(!q.pendingOffer) return null;
  var n=q.pendingOffer; q.waiting=q.waiting.filter(function(x){return x.name!==n;});
  q.holder=n; q.holderSince=new Date().toISOString(); q.pendingOffer=null; return n;
}

/* ---------- session rows ---------- */
function openSession_(name){
  var s = sheet_("Sessions");
  var id = name.replace(/\s+/g,"").slice(0,6).toUpperCase()+"-"+Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
  s.appendRow([id, name, new Date(), "", "", "", 0, 0, 0, "ACTIVE"]);
  return id;
}
function closeSession_(name, durationMin, jds, proposals, copies){
  var s = sheet_("Sessions"); var last=s.getLastRow();
  if(last<2) return;
  var vals = s.getRange(2,1,last-1,10).getValues();
  for(var i=vals.length-1;i>=0;i--){
    if(vals[i][1]===name && vals[i][9]==="ACTIVE"){
      var row=i+2, login=vals[i][2];
      var now=new Date();
      var dmin = (typeof durationMin==="number" && durationMin>=0) ? durationMin
                 : (login instanceof Date ? Math.round((now-login)/60000) : "");
      s.getRange(row,4,1,7).setValues([[now, dmin, hm_(dmin||0), jds||0, proposals||0, copies||0, "CLOSED"]]);
      return dmin;
    }
  }
  // no open row found -> append a closed one so nothing is lost
  s.appendRow(["(auto)", name, "", new Date(), durationMin||"", hm_(durationMin||0), jds||0, proposals||0, copies||0, "CLOSED"]);
  return durationMin;
}

/* ---------- Claude proxy ---------- */
function callClaude_(prompt){
  var key = PropertiesService.getScriptProperties().getProperty("CLAUDE_API_KEY");
  if(!key) return {ok:false, error:"No CLAUDE_API_KEY set", text:null};
  var model = PropertiesService.getScriptProperties().getProperty("CLAUDE_MODEL") || "claude-sonnet-4-5";
  var res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method:"post", contentType:"application/json", muteHttpExceptions:true,
    headers:{ "x-api-key":key, "anthropic-version":"2023-06-01" },
    payload: JSON.stringify({ model:model, max_tokens:1024, messages:[{role:"user",content:prompt}] })
  });
  try{ var j=JSON.parse(res.getContentText()); var text=j&&j.content&&j.content[0]?j.content[0].text:null;
    return {ok:!!text, text:text}; }
  catch(e){ return {ok:false, error:String(e), text:null}; }
}

/* ---------- logs out ---------- */
function logsOut_(){
  var s = sheet_("ActivityLog"); var last=s.getLastRow(); var out=[];
  if(last>=2){
    var rows = s.getRange(2,1,last-1,13).getValues();
    out = rows.map(function(r){ return {ts:r[0],user:r[1],type:r[2],decision:r[3],client:r[4],job:r[5],
      match:r[6],total:r[7],country:r[8],budget:r[9],durationMin:r[10],detail:r[11],summary:r[12]}; })
      .reverse().slice(0,300);
  }
  return out;
}
function json_(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ---------- routing ---------- */
function handle_(data){
  var action = data.action, name = data.name || (data.entry && data.entry.user) || "";
  var q = readQueue_();
  if(action==="login"){
    var st = qJoin_(q, name); writeQueue_(q); openSession_(name);
    return {ok:true, gate:q, gateStatus:st};
  }
  if(action==="logout"){
    var promoted = qLeave_(q, name); writeQueue_(q);
    var dmin = closeSession_(name, data.durationMin, data.jds, data.proposals, data.copies);
    return {ok:true, gate:q, promoted:promoted, durationMin:dmin};
  }
  if(action==="gateAccept"){ qAccept_(q); writeQueue_(q); return {ok:true, gate:q}; }
  if(action==="gateDecline"){ qDecline_(q); writeQueue_(q); return {ok:true, gate:q}; }
  if(action==="log"){
    var e = data.entry || {};
    sheet_("ActivityLog").appendRow([ new Date(), (e.user||name||""), e.type||"", e.decision||"",
      e.client||"", e.job||"", e.match||"", e.total||e.score||"", e.country||"", (e.budget!=null?e.budget:""),
      (e.durationMin!=null?e.durationMin:""), e.detail||"", e.summary||"" ]);
    return {ok:true};
  }
  if(action==="getLogs"){ return {ok:true, logs:logsOut_(), gate:q}; }
  if(action==="claude"){ return callClaude_(data.prompt||""); }
  return {ok:true, note:"no-op"};
}

function doPost(e){
  var data={}; try{ data=JSON.parse(e.postData.contents); }catch(err){ data={}; }
  return json_(handle_(data));
}
function doGet(e){ return json_(handle_((e&&e.parameter)||{})); }
