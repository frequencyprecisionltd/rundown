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
    return out_({ ok: false, error: 'unknown action' });
  } finally {
    lock.releaseLock();
  }
}
