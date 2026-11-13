/**
 * CV share service (Google Apps Script web app).
 *
 * Deploy: Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
 * Setup: run setup() once from the editor; it creates the write token and prints it in the log.
 *
 * Public (no token):
 *   GET ?id=<64 hex>   -> {ok:true, blob, label}  an encrypted CV, if that code exists and has not expired
 *   GET ?id=open       -> {ok:true, cv}           the open (no code) CV, if one is published
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
        'If this was you or Tom, there is nothing to do. If not, ask Tom to change the page password.', { name: 'Rundown' });
    } catch (e) {}
  }
  return { ok: true, isNew: isNew };
}

function index_() { try { return JSON.parse(PROPS.getProperty('index') || '{}'); } catch (e) { return {}; } }

function doGet(e) {
  var id = String((e && e.parameter && e.parameter.id) || '');
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
    if (b.action === 'login') return out_(login_(b));
    if (b.action === 'logins') { var ll; try { ll = JSON.parse(load_('logins') || '[]'); } catch (x) { ll = []; } return out_({ ok: true, items: ll }); }
    return out_({ ok: false, error: 'unknown action' });
  } finally {
    lock.releaseLock();
  }
}
