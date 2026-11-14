/**
 * CV share service (Google Apps Script web app).
 *
 * Deploy: Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
 * Setup: run setup() once from the editor; it creates the write token and prints it in the log.
 *
 * Public (no token):
 *   GET ?id=<64 hex>   -> {ok:true, blob, label}  an encrypted CV, if that code exists and has not expired
 *   GET ?id=open       -> {ok:true, cv}           the open (no code) CV, if one is published
 *   GET ?id=links      -> {ok:true, items}        profile links switched on for the public site
 * Owner (POST, JSON body as text/plain, must include token):
 *   {action:"put", token, id, blob, label, expires}   store an encrypted CV under a code hash
 *   {action:"del", token, id}                          revoke a code
 *   {action:"list", token}                              list shared CVs (labels and dates only)
 *   {action:"open", token, cv}                          publish the open CV (cv=null removes it)
 *   {action:"log", token}                               recent downloads (time, which code, device, time zone, language)
 *   {action:"senders", token}                           addresses this account can send as (Gmail "Send mail as")
 *   {action:"translate", token, texts, from, to}        machine translation as a starting point
 *   {action:"send", token, to, subject, body, from, files, ref, trackReplies}  send an application with CV attached
 *   {action:"sent", token}                              sent applications and whether anyone has replied
 *   {action:"login", token, dev, ua, tz, lang, how}     record an opening of the private page (emails on a new device)
 *   {action:"logins", token}                            list openings of the private page
 *   {action:"contactSettings", token, to?}              which inboxes website messages go to
 *   {action:"links", token, items?}                     profile links shown on the public site
 *   {action:"cvbase", token, cv?, original?, label?}     her general CV as edited on the private page, with up to 15 earlier versions
 *   {action:"vault", token, blob?}                      password notes, encrypted in the browser with the page password
 *   {action:"messages", token}                          messages sent through the website contact form
 *   {action:"correspondence", token}                    sent folder and inbox (last 400 days, flags auto replies) and the not interested list
 *   {action:"mail", token, op:"read"|"spam"|"mute"|"unmute", thread?, who?}  read a thread's full text, move a thread to spam, or mute/unmute a sender or domain
 *   {action:"forms", token, op?:"add"|"status"|"remove", key?, item?, status?, note?}  application forms queued for Claude to fill in
 *   {action:"marks", token, set?}                       Interested / Applied / Sent / Not interested marks shared across devices
 *   {action:"backups", token, op?:"now"}           daily backups in her Google Drive (code zip from GitHub + service data); dailyBackup() runs each night after setupAlerts()
 *   {action:"linkcheck", token, items:[{url,title}]}  is each job advert still there? (gone, redirected elsewhere, or says it has closed)
 *   {action:"notify", token, to?}                      where activity alerts go (her personal inbox); activityCheck() runs hourly after setupAlerts()
 *   {action:"contact", name, email, message}            PUBLIC: the website contact form (no token)
 *
 * The service never sees codes or readable CVs: browsers encrypt with the code before sending,
 * and the id is a one-way hash of the code.
 */
var PROPS = PropertiesService.getScriptProperties();

/** Run once from the editor: creates the write token (if missing) and prints it in the log. */
function setup() {
  var t = PROPS.getProperty('TOKEN');
  if (!t) {
    t = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    PROPS.setProperty('TOKEN', t);
  }
  Logger.log('TOKEN ' + t);
}
var CHUNK = 8000; // script properties hold about 9 KB per value

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function idOk_(id) { return /^[a-f0-9]{64}$/.test(id || ''); }

function save_(key, text) {
  var old = Number(PROPS.getProperty(key + ':n') || 0);
  var n = Math.ceil(text.length / CHUNK) || 1, batch = {};
  for (var i = 0; i < n; i++) batch[key + ':' + i] = text.substr(i * CHUNK, CHUNK);
  batch[key + ':n'] = String(n);
  PROPS.setProperties(batch);
  for (var j = n; j < old; j++) PROPS.deleteProperty(key + ':' + j);
}
function load_(key) {
  var n = Number(PROPS.getProperty(key + ':n') || 0);
  if (!n) return null;
  var s = '';
  for (var i = 0; i < n; i++) s += PROPS.getProperty(key + ':' + i) || '';
  return s;
}
function drop_(key) {
  var n = Number(PROPS.getProperty(key + ':n') || 0);
  for (var i = 0; i < n; i++) PROPS.deleteProperty(key + ':' + i);
  PROPS.deleteProperty(key + ':n');
}
function log_(id, e) {
  var p = (e && e.parameter) || {};
  var list; try { list = JSON.parse(PROPS.getProperty('log') || '[]'); } catch (x) { list = []; }
  list.push({ t: Date.now(), id: id, ua: String(p.ua || '').slice(0, 160), tz: String(p.tz || '').slice(0, 60), lang: String(p.lang || '').slice(0, 20) });
  while (JSON.stringify(list).length > 8500) list.shift();
  PROPS.setProperty('log', JSON.stringify(list));
}
/* ---------- sending applications ---------- */
function me_() { return Session.getEffectiveUser().getEmail(); }
function emailOk_(s) { return /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i.test(s); }

/** Run once from the editor after adding the sending code, so Google asks for permission to send mail. */
function authorise() { Logger.log('Can send as: ' + [me_()].concat(GmailApp.getAliases()).join(', ')); LanguageApp.translate('hello', 'en', 'fr'); }

function send_(b) {
  var to = String(b.to || '').split(/[,;]/).map(function (s) { return s.trim(); }).filter(String);
  if (!to.length || to.length > 5 || !to.every(emailOk_)) return { ok: false, error: 'Check the To address.' };
  var subject = String(b.subject || '').slice(0, 300), body = String(b.body || '');
  if (!subject || !body) return { ok: false, error: 'The subject and letter cannot be empty.' };
  var from = String(b.from || ''), mine = me_(), aliases = GmailApp.getAliases();
  var opts = { attachments: [] };
  if (b.name) opts.name = String(b.name).slice(0, 80);
  if (from && from !== mine) {
    if (aliases.indexOf(from) < 0) return { ok: false, error: 'That From address is not set up yet.' };
    opts.from = from;
    if (b.trackReplies) opts.replyTo = from + ', ' + mine;
  }
  (b.files || []).slice(0, 3).forEach(function (f) {
    var name = String(f.name || 'CV').replace(/[\\\/:*?"<>|]/g, '').slice(0, 120);
    if (f.html) opts.attachments.push(Utilities.newBlob(String(f.html), 'text/html', name + '.html').getAs('application/pdf').setName(name + '.pdf'));
    else if (f.b64) opts.attachments.push(Utilities.newBlob(Utilities.base64Decode(String(f.b64)), String(f.mime || 'application/octet-stream'), name));
  });
  GmailApp.sendEmail(to.join(','), subject, body, opts);
  Utilities.sleep(1500);
  var thread = '';
  try { var th = GmailApp.search('in:sent to:(' + to[0] + ') subject:("' + subject.replace(/"/g, '') + '")', 0, 1); if (th.length) thread = th[0].getId(); } catch (e) {}
  var list = sentList_();
  list.push({ t: Date.now(), to: to.join(', '), subject: subject, from: from || mine, ref: b.ref || null, thread: thread });
  while (list.length > 150) list.shift();
  save_('sent', JSON.stringify(list));
  return { ok: true, thread: thread };
}
function sentList_() { try { return JSON.parse(load_('sent') || '[]'); } catch (e) { return []; } }
function sentStatus_() {
  var mine = [me_()].concat(GmailApp.getAliases()).map(function (s) { return s.toLowerCase(); });
  return sentList_().map(function (s) {
    var r = { t: s.t, to: s.to, subject: s.subject, from: s.from, ref: s.ref, replies: 0, thread: s.thread, account: mine[0] };
    if (!s.thread) return r;
    try {
      var msgs = GmailApp.getThreadById(s.thread).getMessages();
      msgs.forEach(function (m) {
        var f = (m.getFrom().match(/[^\s<>]+@[^\s<>]+/) || [''])[0].toLowerCase();
        if (mine.indexOf(f) < 0) { r.replies++; r.lastReply = m.getDate().getTime(); r.lastFrom = m.getFrom().slice(0, 120); r.snippet = m.getPlainBody().replace(/\s+/g, ' ').slice(0, 220); }
      });
    } catch (e) {}
    return r;
  });
}

/* ---------- correspondence: whole sent folder and inbox ---------- */
var AUTO_RE = /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|auto:|r[ée]ponse automatique|absence|abwesenheit|автоответ|i am (currently )?(away|out)|thank you for (your )?(email|message|application)|we have received)/i;
var GENERIC_DOMAINS = ['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'icloud.com', 'me.com', 'aol.com', 'btinternet.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'orange.fr', 'free.fr', 'wanadoo.fr', 'mail.ru', 'yandex.ru', 'yandex.com', 'web.de', 'sky.com', 'virginmedia.com'];
function addr_(s) { return ((String(s || '').match(/[^\s<>"',;]+@[^\s<>"',;]+/) || [''])[0]).toLowerCase(); }
function isAuto_(m) {
  try {
    var as = String(m.getHeader('Auto-Submitted') || ''), xa = String(m.getHeader('X-Autoreply') || m.getHeader('X-Autorespond') || ''), pr = String(m.getHeader('Precedence') || '');
    if ((as && as.toLowerCase() !== 'no') || xa || /auto_reply|bulk|junk/i.test(pr)) return true;
  } catch (e) {}
  return AUTO_RE.test(String(m.getSubject() || '')) || /^(mailer-daemon|postmaster|no-?reply|donotreply)@/i.test(addr_(m.getFrom()));
}
function muted_() { try { return JSON.parse(PROPS.getProperty('muted') || '[]'); } catch (e) { return []; } }
function correspondence_() {
  var mine = [me_()].concat(GmailApp.getAliases()).map(function (s) { return s.toLowerCase(); });
  var refs = {}; sentList_().forEach(function (s) { if (s.thread) refs[s.thread] = s.ref || null; });
  var sent = [], inbox = [];
  GmailApp.search('in:sent newer_than:400d', 0, 120).forEach(function (th) {
    th.getMessages().forEach(function (m) {
      if (mine.indexOf(addr_(m.getFrom())) < 0) return;
      sent.push({ t: m.getDate().getTime(), to: String(m.getTo() || '').slice(0, 300), cc: String(m.getCc() || '').slice(0, 200), subject: String(m.getSubject() || '').slice(0, 200), thread: th.getId(), ref: refs[th.getId()] || null, from: addr_(m.getFrom()) });
    });
  });
  GmailApp.search('in:inbox newer_than:400d', 0, 120).forEach(function (th) {
    var msgs = th.getMessages();
    for (var i = msgs.length - 1; i >= 0; i--) {
      var m = msgs[i], f = addr_(m.getFrom());
      if (mine.indexOf(f) >= 0) continue;
      inbox.push({ t: m.getDate().getTime(), from: String(m.getFrom() || '').slice(0, 160), addr: f, subject: String(m.getSubject() || '').slice(0, 200), snippet: m.getPlainBody().replace(/\s+/g, ' ').slice(0, 260), thread: th.getId(), auto: isAuto_(m), unread: th.isUnread(), count: msgs.length });
      break;
    }
  });
  sent.sort(function (a, b) { return b.t - a.t; }); inbox.sort(function (a, b) { return b.t - a.t; });
  return { ok: true, account: mine[0], sent: sent, inbox: inbox, muted: muted_() };
}
function mailBody_(b) {
  var th = GmailApp.getThreadById(String(b.thread || '')); if (!th) return { ok: false };
  var msgs = th.getMessages().slice(-6);
  return { ok: true, subject: th.getFirstMessageSubject(), messages: msgs.map(function (m) {
    return { t: m.getDate().getTime(), from: String(m.getFrom() || '').slice(0, 160), to: String(m.getTo() || '').slice(0, 300), body: m.getPlainBody().replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').slice(0, 12000) };
  }) };
}
function mail_(b) {
  if (b.op === 'read' && b.thread) return mailBody_(b);
  if (b.op === 'spam' && b.thread) { GmailApp.getThreadById(String(b.thread)).moveToSpam(); return { ok: true }; }
  if (b.op === 'mute' || b.op === 'unmute') {
    var who = String(b.who || '').toLowerCase().trim(); if (!who || who.length > 120) return { ok: false };
    var list = muted_().filter(function (x) { return x !== who; }); if (b.op === 'mute') list.push(who);
    PROPS.setProperty('muted', JSON.stringify(list.slice(-300))); return { ok: true, muted: list };
  }
  return { ok: false };
}
/* ---------- forms the owner wants Claude to fill in (application forms with no email address) ---------- */
function forms_(b) {
  var list; try { list = JSON.parse(load_('forms') || '[]'); } catch (e) { list = []; }
  var key = String(b.key || '').slice(0, 120);
  if (b.op === 'add' && b.item && key) {
    var it = b.item, url = String(it.url || '');
    if (!/^https:\/\/[^\s"'<>]+$/.test(url)) return { ok: false, error: 'Please paste the full web address of the form, starting https://' };
    list = list.filter(function (x) { return x.key !== key; });
    list.push({ key: key, kind: String(it.kind || '').slice(0, 10), id: String(it.id || '').slice(0, 120), label: String(it.label || '').slice(0, 200), url: url.slice(0, 1000), advert: /^https?:\/\//.test(String(it.advert || '')) ? String(it.advert).slice(0, 1000) : '', note: String(it.note || '').slice(0, 1000), status: 'waiting', t: Date.now() });
  }
  if (b.op === 'status' && key) list.forEach(function (x) { if (x.key === key) { x.status = String(b.status || 'waiting').slice(0, 20); x.claudeNote = String(b.note || '').slice(0, 1000); x.t2 = Date.now(); } });
  if (b.op === 'remove' && key) list = list.filter(function (x) { return x.key !== key; });
  if (b.op) save_('forms', JSON.stringify(list.slice(-100)));
  return { ok: true, items: list };
}
/* ---------- marks (Interested, Applied, Sent, Not interested), shared across devices ---------- */
function marks_(b) {
  var m; try { m = JSON.parse(load_('marks') || '{}'); } catch (e) { m = {}; }
  if (b.set && typeof b.set === 'object') {
    Object.keys(b.set).slice(0, 200).forEach(function (k) { if (/^(job|out):[\w.-]{1,80}$/.test(k)) { var v = String(b.set[k]).slice(0, 20); if (v === 'new') delete m[k]; else m[k] = { s: v, t: Date.now() }; } });
    save_('marks', JSON.stringify(m));
  }
  return { ok: true, marks: m };
}

/* ---------- activity alerts to her personal inbox ---------- */
// The address lives only in Script Properties (key "notifyTo"), set from the private page or the editor's Project Settings.
// Where the board lives. If it moves (new GitHub account or another host), set the Script Properties
// "pageUrl" (the board's address) and "repo" (owner/name on GitHub); no code change is needed.
var PAGE_URL = PROPS.getProperty('pageUrl') || 'https://frequencyprecisionltd.github.io/rundown/';
var REPO = PROPS.getProperty('repo') || 'frequencyprecisionltd/rundown';
var REPO_COMMITS = 'https://api.github.com/repos/' + REPO + '/commits?path=data.enc.json&per_page=20&since=';

/* ---------- is a job advert still there? ---------- */
var CLOSED_RE = /no longer (available|accepting|open|active|live)|has (now )?(expired|closed)|this (job|vacancy|position|role|advert) (has|is) (now )?(closed|expired|been filled|no longer)|position (has been|is) filled|job not found|vacancy not found|page not found|could not be found|cannot be found|n'est plus (disponible|en ligne)|offre (expirée|pourvue|n'existe plus)|annonce (expirée|n'est plus)/i;
function linkOne_(url, title) {
  var cache = CacheService.getScriptCache(), ck = 'lc:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, url));
  var hit = cache.get(ck); if (hit) return JSON.parse(hit);
  var r = { url: url, state: 'ok', reason: '' };
  try {
    var cur = url, code = 0, res, hops = 0;
    while (hops < 5) {
      res = UrlFetchApp.fetch(cur, { muteHttpExceptions: true, followRedirects: false, headers: { 'User-Agent': 'Mozilla/5.0 (job board link check)' } });
      code = res.getResponseCode();
      if (code >= 300 && code < 400) { var loc = res.getHeaders()['Location'] || res.getHeaders()['location']; if (!loc) break; cur = loc.indexOf('http') === 0 ? loc : cur.replace(/^(https?:\/\/[^\/]+).*$/, '$1') + (loc.charAt(0) === '/' ? '' : '/') + loc; hops++; continue; }
      break;
    }
    r.code = code; r.finalUrl = cur;
    var path = function (u) { return String(u).replace(/^https?:\/\/[^\/]+/, '').replace(/[?#].*$/, '').replace(/\/$/, ''); };
    var host = function (u) { return (String(u).match(/^https?:\/\/([^\/]+)/) || [])[1] || ''; };
    var text = code === 200 ? res.getContentText().slice(0, 400000) : '';
    var words = String(title || '').toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter(function (w) { return w.length > 3; });
    var found = words.filter(function (w) { return text.toLowerCase().indexOf(w) >= 0; }).length;
    if (code === 404 || code === 410) { r.state = 'gone'; r.reason = 'The advert page no longer exists (error ' + code + ').'; }
    else if (code >= 400 && code !== 403 && code !== 429) { r.state = 'unsure'; r.reason = 'The advert site answered with error ' + code + '.'; }
    else if (hops && (host(cur) !== host(url) || path(cur).length < path(url).length * 0.6)) { r.state = 'gone'; r.reason = 'The advert now redirects somewhere else (' + cur.slice(0, 120) + '), so it has probably been taken down.'; }
    else if (text && CLOSED_RE.test(text)) { r.state = 'gone'; r.reason = 'The advert page says it has closed or is no longer available.'; }
    else if (text && words.length >= 2 && found === 0) { r.state = 'unsure'; r.reason = 'The page no longer mentions this job title, so it may have been replaced by another job.'; }
  } catch (e) { r.state = 'unsure'; r.reason = 'The advert site could not be reached just now.'; }
  cache.put(ck, JSON.stringify(r), 6 * 3600);
  return r;
}
function linkcheck_(b) {
  var items = (b.items || []).slice(0, 25).filter(function (i) { return /^https?:\/\//.test(String(i.url || '')); });
  return { ok: true, items: items.map(function (i) { return linkOne_(String(i.url), String(i.title || '')); }) };
}

/* ---------- backups in her Google Drive ---------- */
// Each night: a zip of the whole board (code plus encrypted data, straight from GitHub) and a file of everything this
// service keeps (marks, forms, CV versions, messages, settings). Kept in the Drive folder "Job board backups", newest 30 of each.
// If GitHub is ever lost, the newest zip is all that is needed to set the board up again (see the Handover notes).
var BACKUP_FOLDER = 'Job board backups';
function backupFolder_() { var it = DriveApp.getFoldersByName(BACKUP_FOLDER); return it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER); }
function dailyBackup() {
  var f = backupFolder_(), stamp = Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd'), notes = [];
  try {
    var res = UrlFetchApp.fetch('https://codeload.github.com/' + REPO + '/zip/refs/heads/main', { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) { var z = res.getBlob().setName('board-code-and-data-' + stamp + '.zip'); var old = f.getFilesByName(z.getName()); while (old.hasNext()) old.next().setTrashed(true); f.createFile(z); notes.push('zip'); }
    else notes.push('GitHub answered ' + res.getResponseCode() + ', older zips kept');
  } catch (e) { notes.push('GitHub not reachable, older zips kept'); }
  var all = PROPS.getProperties(); delete all.TOKEN;
  var name = 'service-data-' + stamp + '.json', o2 = f.getFilesByName(name); while (o2.hasNext()) o2.next().setTrashed(true);
  f.createFile(name, JSON.stringify(all), 'application/json'); notes.push('service data');
  ['board-code-and-data-', 'service-data-'].forEach(function (pre) {
    var list = [], it = f.getFiles(); while (it.hasNext()) { var x = it.next(); if (x.getName().indexOf(pre) === 0) list.push(x); }
    list.sort(function (a, b) { return b.getName() < a.getName() ? -1 : 1; }).slice(30).forEach(function (x) { x.setTrashed(true); });
  });
  PROPS.setProperty('backupLast', JSON.stringify({ t: Date.now(), notes: notes }));
  return notes.join(', ');
}
function backups_(b) {
  var note = null; if (b.op === 'now') note = dailyBackup();
  var f = backupFolder_(), items = [], it = f.getFiles();
  while (it.hasNext()) { var x = it.next(); items.push({ name: x.getName(), url: x.getUrl(), size: x.getSize(), t: x.getDateCreated().getTime() }); }
  items.sort(function (a, c) { return c.t - a.t; });
  var last; try { last = JSON.parse(PROPS.getProperty('backupLast') || 'null'); } catch (e) { last = null; }
  return { ok: true, folder: f.getUrl(), items: items.slice(0, 20), last: last, note: note, repo: REPO, page: PAGE_URL };
}
function notifyTo_() { return String(PROPS.getProperty('notifyTo') || '').split(',').map(function (s) { return s.trim(); }).filter(emailOk_); }
function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
// Runs on a timer (see setupAlerts). Emails only when there is something new since the last check.
function activityCheck() {
  var to = notifyTo_(); if (!to.length) return 'no address set';
  var now = Date.now(), last = Number(PROPS.getProperty('alertLast') || 0) || (now - 24 * 3600 * 1000);
  var lines = [];
  // 1. Board updates: the morning run pushes data.enc.json with a message like "Update: 3 new roles, 3 speculative emails".
  try {
    var res = UrlFetchApp.fetch(REPO_COMMITS + new Date(last).toISOString(), { muteHttpExceptions: true, headers: { 'Accept': 'application/vnd.github+json' } });
    if (res.getResponseCode() === 200) {
      var commits = JSON.parse(res.getContentText()), notes = [];
      commits.forEach(function (c) {
        var m = String((c.commit && c.commit.message) || '').split('\n')[0], d = m.match(/^Update:\s*(.+)$/i);
        if (d) notes.push(d[1].trim());
      });
      if (notes.length) lines.push({ text: 'New on your board: ' + notes.reverse().join('; ') + '.' }); // a plain "Update" (nothing new) sends nothing
    }
  } catch (e) {}
  // 2. New emails in the application inbox: replies from anyone she wrote to (same address or same organisation domain,
  //    any thread), automatic replies, and other new mail. Senders marked Not interested are ignored.
  try {
    var c = correspondence_(), muted = c.muted, wrote = {}, wroteDom = {};
    c.sent.forEach(function (s) { (s.to + ',' + s.cc).split(/[,;]/).map(addr_).filter(String).forEach(function (a) { wrote[a] = s.subject; var d = a.split('@')[1]; if (GENERIC_DOMAINS.indexOf(d) < 0) wroteDom[d] = s.subject; }); });
    var others = 0;
    c.inbox.filter(function (m) { return m.t > last; }).forEach(function (m) {
      var dom = m.addr.split('@')[1] || '';
      if (muted.indexOf(m.addr) >= 0 || muted.indexOf(dom) >= 0) return;
      if (/^(mailer-daemon|postmaster)@/.test(m.addr)) {
        var failed = ((m.snippet + ' ' + m.subject).match(/[^\s<>"',;()]+@[^\s<>"',;()]+/g) || []).map(function (x) { return x.toLowerCase(); }).filter(function (x) { return !/^(mailer-daemon|postmaster)@|googlemail\.com$|google\.com$/.test(x); })[0];
        if (failed) lines.push({ text: 'Not delivered: your email to ' + failed + ' bounced because the address does not work. Look for another contact on their website.' });
        return;
      }
      var about = wrote[m.addr] || wroteDom[dom];
      if (about) lines.push({ text: (m.auto ? 'Automatic reply' : 'Reply') + ' from ' + m.from + ' (you wrote: "' + about + '"): ' + m.snippet, strong: !m.auto });
      else if (!m.auto) others++;
    });
    if (others) lines.push({ text: others + (others === 1 ? ' other new email' : ' other new emails') + ' in your application inbox. Open Correspondence to sort them.' });
  } catch (e) {}
  // 3. Messages through the website.
  var msgs; try { msgs = JSON.parse(load_('messages') || '[]'); } catch (x) { msgs = []; }
  var fresh = msgs.filter(function (m) { return m.t > last; });
  if (fresh.length) lines.push({ text: fresh.length + (fresh.length === 1 ? ' new message' : ' new messages') + ' through your website, from ' + fresh.map(function (m) { return m.name; }).join(', ') + '.' });
  PROPS.setProperty('alertLast', String(now));
  if (!lines.length) return 'nothing new';
  var replies = lines.some(function (l) { return l.strong; });
  var subject = replies ? 'Someone has replied to you' : 'New activity on your job board';
  var text = 'Hello,\n\n' + lines.map(function (l) { return '* ' + l.text; }).join('\n') + '\n\nOpen your board to see everything:\n' + PAGE_URL + '\n';
  var html = '<p>Hello,</p><ul>' + lines.map(function (l) { return '<li>' + (l.strong ? '<b>' + esc_(l.text) + '</b>' : esc_(l.text)) + '</li>'; }).join('') +
    '</ul><p><a href="' + PAGE_URL + '">Open your board</a> to see everything.</p><p style="color:#777;font-size:12px">' + PAGE_URL + '</p>';
  GmailApp.sendEmail(to.join(','), subject, text, { htmlBody: html, name: 'Your job board' });
  return 'sent: ' + lines.length;
}
// Run once from the editor: checks for new activity every hour.
function setupAlerts() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'activityCheck') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('activityCheck').timeBased().everyHours(1).create();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailyBackup') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(4).inTimezone('Europe/London').create();
  try { dailyBackup(); } catch (e) { Logger.log('Backup could not run yet: ' + e); }
  if (!PROPS.getProperty('alertLast')) PROPS.setProperty('alertLast', String(Date.now()));
  Logger.log('Alerts on. Sending to: ' + (notifyTo_().join(', ') || '(no address yet: set notifyTo in Project Settings > Script Properties)'));
}

/* ---------- public contact form ---------- */
function contactTo_() { try { var t = JSON.parse(PROPS.getProperty('contactTo') || '[]'); return t.length ? t : [me_()]; } catch (e) { return [me_()]; } }
function contact_(b) {
  if (b.hp) return { ok: true }; // filled by robots only
  var name = String(b.name || '').trim().slice(0, 100), email = String(b.email || '').trim().slice(0, 120), msg = String(b.message || '').trim().slice(0, 5000);
  if (!name || !msg || !emailOk_(email)) return { ok: false, error: 'missing' };
  var cache = CacheService.getScriptCache(), n = Number(cache.get('contactCount') || 0);
  if (n >= 20) return { ok: false, error: 'busy' };
  cache.put('contactCount', String(n + 1), 3600);
  var list; try { list = JSON.parse(load_('messages') || '[]'); } catch (x) { list = []; }
  list.push({ t: Date.now(), name: name, email: email, message: msg, lang: String(b.lang || '').slice(0, 20), tz: String(b.tz || '').slice(0, 60) });
  while (JSON.stringify(list).length > 60000) list.shift();
  save_('messages', JSON.stringify(list));
  try {
    GmailApp.sendEmail(contactTo_().join(','), 'Message from your website: ' + name,
      name + ' (' + email + ') sent you a message through your website:\n\n' + msg + '\n\nReply to this email to answer them directly.',
      { replyTo: email, name: 'Your website' });
  } catch (e) {}
  return { ok: true };
}

/* ---------- private page openings ---------- */
function login_(b) {
  var list; try { list = JSON.parse(load_('logins') || '[]'); } catch (x) { list = []; }
  var dev = String(b.dev || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
  var isNew = !!dev && list.length > 0 && !list.some(function (l) { return l.dev === dev; });
  var rec = { t: Date.now(), dev: dev, ua: String(b.ua || '').slice(0, 160), tz: String(b.tz || '').slice(0, 60), lang: String(b.lang || '').slice(0, 20), how: b.how === 'typed' ? 'typed' : 'remembered' };
  list.push(rec);
  while (list.length > 400) list.shift();
  save_('logins', JSON.stringify(list));
  if (isNew) {
    try {
      GmailApp.sendEmail(me_(), 'Your Rundown page was opened on a new device',
        'Someone opened your private Rundown page on a device it has not seen before.\n\n' +
        'When: ' + Utilities.formatDate(new Date(rec.t), 'Europe/London', 'EEEE d MMMM yyyy, HH:mm') + ' (UK time)\n' +
        'Device: ' + rec.ua + '\nTime zone: ' + (rec.tz || 'unknown') + '\nLanguage: ' + (rec.lang || 'unknown') + '\n\n' +
        'If this was you or someone you trust, there is nothing to do. If not, change the page password (see the Handover tab).', { name: 'Rundown' });
    } catch (e) {}
  }
  return { ok: true, isNew: isNew };
}

function index_() { try { return JSON.parse(PROPS.getProperty('index') || '{}'); } catch (e) { return {}; } }

function doGet(e) {
  var id = String((e && e.parameter && e.parameter.id) || '');
  if (id === 'links') { var lk; try { lk = JSON.parse(PROPS.getProperty('links') || '[]'); } catch (x) { lk = []; } return out_({ ok: true, items: lk }); }
  if (id === 'open') {
    var cv = load_('open');
    if (cv && e.parameter.dl) log_('open', e);
    return out_(cv ? { ok: true, cv: JSON.parse(cv) } : { ok: false });
  }
  if (!idOk_(id)) return out_({ ok: false });
  var meta = index_()[id];
  if (!meta || (meta.expires && Date.now() > meta.expires)) return out_({ ok: false });
  var blob = load_('cv_' + id);
  if (blob) log_(id, e);
  return out_(blob ? { ok: true, blob: JSON.parse(blob), label: meta.label || '' } : { ok: false });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var b = JSON.parse(e.postData.contents || '{}');
    if (b.action === 'contact') return out_(contact_(b));
    var token = PROPS.getProperty('TOKEN');
    if (!token || b.token !== token) return out_({ ok: false, error: 'not allowed' });
    var idx = index_();
    if (b.action === 'put') {
      if (!idOk_(b.id) || !b.blob) return out_({ ok: false, error: 'bad request' });
      save_('cv_' + b.id, JSON.stringify(b.blob));
      idx[b.id] = { label: String(b.label || '').slice(0, 200), created: Date.now(), expires: Number(b.expires) || 0 };
      PROPS.setProperty('index', JSON.stringify(idx));
      return out_({ ok: true });
    }
    if (b.action === 'del') {
      if (!idOk_(b.id)) return out_({ ok: false, error: 'bad request' });
      drop_('cv_' + b.id); delete idx[b.id];
      PROPS.setProperty('index', JSON.stringify(idx));
      return out_({ ok: true });
    }
    if (b.action === 'list') {
      var list = Object.keys(idx).map(function (k) { return { id: k, label: idx[k].label, created: idx[k].created, expires: idx[k].expires }; });
      return out_({ ok: true, items: list, open: !!PROPS.getProperty('open:n') });
    }
    if (b.action === 'log') {
      var lg; try { lg = JSON.parse(PROPS.getProperty('log') || '[]'); } catch (x) { lg = []; }
      return out_({ ok: true, items: lg });
    }
    if (b.action === 'open') {
      if (b.cv) save_('open', JSON.stringify(b.cv)); else drop_('open');
      return out_({ ok: true });
    }
    if (b.action === 'senders') return out_({ ok: true, primary: me_(), aliases: GmailApp.getAliases() });
    if (b.action === 'translate') {
      var to = String(b.to || ''), from = String(b.from || 'en');
      if (!/^[a-z]{2}$/.test(to)) return out_({ ok: false, error: 'bad request' });
      var parts = (b.texts || []).map(function (t) { return t ? LanguageApp.translate(String(t), from, to) : ''; });
      return out_({ ok: true, texts: parts });
    }
    if (b.action === 'send') return out_(send_(b));
    if (b.action === 'sent') return out_({ ok: true, items: sentStatus_() });
    if (b.action === 'correspondence') return out_(correspondence_());
    if (b.action === 'mail') return out_(mail_(b));
    if (b.action === 'marks') return out_(marks_(b));
    if (b.action === 'forms') return out_(forms_(b));
    if (b.action === 'backups') return out_(backups_(b));
    if (b.action === 'linkcheck') return out_(linkcheck_(b));
    if (b.action === 'notify') {
      if (b.to !== undefined) { var nt = [].concat(b.to).map(String).map(function (s) { return s.trim(); }).filter(emailOk_).slice(0, 3); PROPS.setProperty('notifyTo', nt.join(',')); }
      return out_({ ok: true, to: notifyTo_() });
    }
    if (b.action === 'login') return out_(login_(b));
    if (b.action === 'contactSettings') {
      if (b.to) { var t2 = [].concat(b.to).map(String).filter(emailOk_).slice(0, 3); PROPS.setProperty('contactTo', JSON.stringify(t2)); }
      return out_({ ok: true, to: contactTo_(), primary: me_() });
    }
    if (b.action === 'links') {
      if (b.items) {
        var clean = [].concat(b.items).slice(0, 12).map(function (it) {
          return { label: String(it.label || '').slice(0, 60), url: String(it.url || ''), kind: String(it.kind || 'web').replace(/[^a-z]/g, '').slice(0, 20), mode: it.mode === 'feed' ? 'feed' : 'icon', handle: String(it.handle || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 30) };
        }).filter(function (it) { return /^https:\/\/[^\s"'<>]+$/.test(it.url); });
        PROPS.setProperty('links', JSON.stringify(clean));
      }
      var cur; try { cur = JSON.parse(PROPS.getProperty('links') || '[]'); } catch (x) { cur = []; }
      return out_({ ok: true, items: cur });
    }
    if (b.action === 'cvbase') {
      var hist; try { hist = JSON.parse(load_('cvhist') || '[]'); } catch (x) { hist = []; }
      var curS = load_('cvbase');
      if (b.cv) {
        if (curS) hist.push({ t: Number(PROPS.getProperty('cvbase:t') || 0) || Date.now(), label: String(PROPS.getProperty('cvbase:label') || ''), cv: JSON.parse(curS) });
        else if (b.original) hist.push({ t: Date.now(), label: 'Original', cv: b.original });
        while (hist.length > 15) hist.shift();
        while (JSON.stringify(hist).length > 300000 && hist.length > 1) hist.shift();
        save_('cvhist', JSON.stringify(hist));
        save_('cvbase', JSON.stringify(b.cv));
        PROPS.setProperty('cvbase:t', String(Date.now()));
        PROPS.setProperty('cvbase:label', String(b.label || '').slice(0, 80));
        curS = JSON.stringify(b.cv);
      }
      return out_({ ok: true, cv: curS ? JSON.parse(curS) : null, t: Number(PROPS.getProperty('cvbase:t') || 0), history: hist });
    }
    if (b.action === 'vault') {
      if (b.blob) save_('vault', JSON.stringify(b.blob));
      var vb = load_('vault');
      return out_({ ok: true, blob: vb ? JSON.parse(vb) : null });
    }
    if (b.action === 'messages') { var mm; try { mm = JSON.parse(load_('messages') || '[]'); } catch (x) { mm = []; } return out_({ ok: true, items: mm }); }
    if (b.action === 'logins') { var ll; try { ll = JSON.parse(load_('logins') || '[]'); } catch (x) { ll = []; } return out_({ ok: true, items: ll }); }
    return out_({ ok: false, error: 'unknown action' });
  } finally {
    lock.releaseLock();
  }
}
