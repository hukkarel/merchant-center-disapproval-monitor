/**
 * ============================================================================
 *  DENNÍ MONITORING ZAMÍTNUTÝCH PRODUKTŮ V GOOGLE MERCHANT CENTER
 * ============================================================================
 *
 *  Merchant Center vám o zhoršení neřekne. Ukáže aktuální stav, ne to, že
 *  jich včera bylo 12 a dnes 260. Tenhle skript ten rozdíl hlídá za vás:
 *  jednou denně načte stav přes Merchant API, porovná ho s předchozím během
 *  a když se něco zhorší, pošle zprávu do Google Chatu nebo e-mailem.
 *
 *  Alert obsahuje tři věci, které potřebujete k rozhodnutí:
 *    - absolutní rozdíl (bylo 12, je 260)
 *    - podíl na katalogu (0,3 % → 27 %)
 *    - důvody, seřazené podle toho, kolika produktů se týkají
 *
 *  INSTALACE (10 minut, podrobně v README)
 *    1. script.google.com → Nový projekt, vložte tenhle soubor
 *    2. Nastavení projektu → zaškrtněte "Zobrazit soubor appsscript.json"
 *       → vložte appsscript.json z repozitáře
 *    3. Nastavení projektu → Projekt Google Cloud → přepněte na vlastní
 *       projekt, kde máte povolené Merchant API
 *    4. Níže vyplňte MERCHANT_ID a alespoň jeden kanál pro alert
 *    5. Spusťte runOnce(), povolte oprávnění, zkontrolujte log
 *    6. Spusťte installDailyTrigger() a je hotovo
 *
 *  Merchant API v1. Verze v1beta byla zrušena 28. 2. 2026, návody, které
 *  ji ještě používají, dnes vrací HTTP 409.
 *
 *  Copyright (c) 2026 Karel Huk — karelhuk.cz · licence MIT
 *  Software je poskytován „tak jak je", bez záruky.
 */

// ============================================================================
//  NASTAVENÍ
// ============================================================================

var CONFIG = {

  // --- účet ---
  // ID účtu Merchant Center, bez mezer. Najdete ho vpravo nahoře v rozhraní.
  // Pro víc účtů najednou: ['123456789', '987654321'].
  MERCHANT_ID: '',

  // --- kam poslat alert (aspoň jedno) ---
  // Google Chat: v místnosti → název → Aplikace a integrace → Webhooky.
  CHAT_WEBHOOK_URL: '',
  // Víc adres oddělte čárkou.
  EMAIL: '',

  // --- kdy alert poslat ---
  // Stačí, aby platila jedna z podmínek. Prahy jsou volba, ne doporučení
  // Googlu: nastavte je podle toho, co u vás znamená „něco se stalo".
  ALERT_ON_ABSOLUTE_INCREASE: 10,   // přibylo aspoň tolik zamítnutých produktů
  ALERT_ON_RELATIVE_INCREASE: 20,   // nebo přibylo aspoň o tolik % proti včerejšku
  ALERT_ON_NEW_ISSUE_TYPE: true,    // nebo se objevil důvod, který včera nebyl
  ALERT_ON_SHARE_ABOVE: 5,          // nebo zamítnuté přesáhly tolik % katalogu

  // Poslat zprávu i ve dnech, kdy je všechno v pořádku. Vypnuté proto, že
  // denní „nic se nestalo" se po týdnu přestane číst.
  ALWAYS_NOTIFY: false,

  // --- historie ---
  // Volitelný Google Sheet pro historii běhů. Prázdné = nezapisovat.
  // Skript si v něm založí list "gmc-monitor" a přidává jeden řádek denně.
  SPREADSHEET_URL: '',

  // --- rozsah ---
  // Sledovat i produkty, které běží s omezením (ELIGIBLE_LIMITED). Ty se
  // zobrazují, ale hůř. Typicky chybějící GTIN nebo doprava.
  TRACK_LIMITED: true,

  // Kolik důvodů vypsat do alertu. Zbytek se sečte do „a další".
  MAX_ISSUES_IN_ALERT: 8,
};

// ============================================================================
//  VEŘEJNÉ FUNKCE — tyhle se spouští z editoru
// ============================================================================

/** Jeden běh: načte stav, porovná, případně pošle alert. */
function runOnce() {
  var ids = Array.isArray(CONFIG.MERCHANT_ID) ? CONFIG.MERCHANT_ID : [CONFIG.MERCHANT_ID];
  ids = ids.map(function (id) { return String(id).replace(/\D/g, ''); }).filter(Boolean);

  if (!ids.length) throw new Error('Vyplňte MERCHANT_ID v CONFIG.');
  if (!CONFIG.CHAT_WEBHOOK_URL && !CONFIG.EMAIL) {
    Logger.log('POZOR: není vyplněný ani CHAT_WEBHOOK_URL, ani EMAIL. Výsledek uvidíte jen v logu.');
  }

  ids.forEach(function (id) {
    try {
      checkAccount_(id);
    } catch (err) {
      Logger.log('Účet ' + id + ' selhal: ' + err.message);
      notifyError_(id, err);
    }
  });
}

/** Naplánuje runOnce() na každý den v 7:00. Spustit jednou. */
function installDailyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('runOnce').timeBased().atHour(7).everyDays(1).create();
  Logger.log('Hotovo. runOnce() poběží každý den kolem 7:00 v časovém pásmu projektu.');
}

/** Zruší všechny triggery tohoto skriptu. */
function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('Triggery zrušeny.');
}

/** Zapomene uloženou historii. Další běh nebude mít s čím porovnávat. */
function resetHistory() {
  PropertiesService.getScriptProperties().deleteAllProperties();
  Logger.log('Historie smazána.');
}

// ============================================================================
//  JÁDRO
// ============================================================================

function checkAccount_(merchantId) {
  var snapshot = fetchSnapshot_(merchantId);
  var previous = loadPrevious_(merchantId);
  var verdict = compare_(previous, snapshot);

  Logger.log(formatPlainText_(merchantId, snapshot, previous, verdict));

  if (CONFIG.SPREADSHEET_URL) appendToSheet_(merchantId, snapshot);
  savePrevious_(merchantId, snapshot);

  if (!verdict.shouldAlert && !CONFIG.ALWAYS_NOTIFY) return;
  sendAlert_(merchantId, snapshot, previous, verdict);
}

/**
 * Jeden dotaz přes celý katalog. Vrací status každého produktu a u problémových
 * i seznam důvodů, takže se počty i důvody spočítají z jednoho průchodu.
 *
 * Pozor na velikost katalogu: Apps Script má na jeden běh 6 minut (30 minut
 * u Workspace). Nad zhruba 200 000 produktů to nemusí stihnout — pak sledujte
 * jednotlivé feed_label zvlášť, viz README.
 */
function fetchSnapshot_(merchantId) {
  var query =
    'SELECT product_view.id, product_view.aggregated_reporting_context_status,' +
    ' product_view.item_issues FROM product_view';

  var total = 0;
  var byStatus = {};
  var issueCounts = {};
  var pageToken = null;

  do {
    var page = merchantApiSearch_(merchantId, query, pageToken);
    var results = page.results || [];

    for (var i = 0; i < results.length; i++) {
      var pv = results[i].productView || {};
      var status = pv.aggregatedReportingContextStatus || 'UNKNOWN';
      total++;
      byStatus[status] = (byStatus[status] || 0) + 1;

      // Důvody počítáme jen tam, kde produkt reálně nejede: zamítnutý vždy,
      // omezený jen když ho sledujeme. Jeden produkt může mít víc důvodů,
      // takže součet přes důvody bývá vyšší než počet produktů.
      var counts = status === 'NOT_ELIGIBLE_OR_DISAPPROVED' ||
        (CONFIG.TRACK_LIMITED && status === 'ELIGIBLE_LIMITED');
      if (!counts) continue;

      var issues = pv.itemIssues || [];
      for (var j = 0; j < issues.length; j++) {
        var code = (issues[j].type && issues[j].type.code) || 'unknown_issue';
        var severity = (issues[j].severity && issues[j].severity.aggregatedSeverity) || '';
        var key = severity ? code + ' (' + severity.toLowerCase() + ')' : code;
        issueCounts[key] = (issueCounts[key] || 0) + 1;
      }
    }

    pageToken = page.nextPageToken || null;
  } while (pageToken);

  var disapproved = byStatus['NOT_ELIGIBLE_OR_DISAPPROVED'] || 0;
  var limited = byStatus['ELIGIBLE_LIMITED'] || 0;

  return {
    date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
    total: total,
    disapproved: disapproved,
    limited: limited,
    pending: byStatus['PENDING'] || 0,
    eligible: byStatus['ELIGIBLE'] || 0,
    // Sledované = to, na co reagují prahy. Bez omezených, pokud je nesledujete.
    watched: disapproved + (CONFIG.TRACK_LIMITED ? limited : 0),
    issues: issueCounts,
  };
}

/**
 * Rozhodnutí, jestli poslat alert. Vrací i důvody, aby zpráva mohla říct,
 * která podmínka se spustila — bez toho příjemce neví, na co reagovat.
 */
function compare_(previous, current) {
  var reasons = [];
  var newIssues = [];

  var share = current.total ? (100 * current.watched / current.total) : 0;

  if (!previous) {
    // První běh nemá s čím porovnávat. Alert pošleme jen tehdy, když je
    // katalog v tak špatném stavu, že by to člověk chtěl vědět hned.
    if (CONFIG.ALERT_ON_SHARE_ABOVE && share >= CONFIG.ALERT_ON_SHARE_ABOVE) {
      reasons.push('první běh, zasaženo ' + fmtPct_(share) + ' katalogu');
    }
    return { shouldAlert: reasons.length > 0, reasons: reasons, newIssues: [], delta: null, share: share };
  }

  var delta = current.watched - previous.watched;
  var relative = previous.watched > 0 ? (100 * delta / previous.watched) : (delta > 0 ? Infinity : 0);

  if (CONFIG.ALERT_ON_ABSOLUTE_INCREASE && delta >= CONFIG.ALERT_ON_ABSOLUTE_INCREASE) {
    reasons.push('přibylo ' + delta + ' produktů, práh je ' + CONFIG.ALERT_ON_ABSOLUTE_INCREASE);
  }
  if (CONFIG.ALERT_ON_RELATIVE_INCREASE && relative >= CONFIG.ALERT_ON_RELATIVE_INCREASE) {
    reasons.push('nárůst o ' + fmtPct_(relative) + ', práh je ' + CONFIG.ALERT_ON_RELATIVE_INCREASE + ' %');
  }
  if (CONFIG.ALERT_ON_SHARE_ABOVE && share >= CONFIG.ALERT_ON_SHARE_ABOVE) {
    reasons.push('zasaženo ' + fmtPct_(share) + ' katalogu, práh je ' + CONFIG.ALERT_ON_SHARE_ABOVE + ' %');
  }
  if (CONFIG.ALERT_ON_NEW_ISSUE_TYPE) {
    for (var code in current.issues) {
      if (!previous.issues || !previous.issues[code]) newIssues.push(code);
    }
    if (newIssues.length) {
      reasons.push('nový důvod zamítnutí: ' + newIssues.slice(0, 3).join(', ') +
        (newIssues.length > 3 ? ' a další' : ''));
    }
  }

  return { shouldAlert: reasons.length > 0, reasons: reasons, newIssues: newIssues, delta: delta, relative: relative, share: share };
}

// ============================================================================
//  MERCHANT API
// ============================================================================

/**
 * Volání reports.search. Autorizuje se tokenem projektu Apps Scriptu, takže
 * nikam neukládáte klíč ani heslo — účet stačí mít připojený pod tímtéž
 * Google účtem, pod kterým skript spouštíte.
 */
function merchantApiSearch_(merchantId, query, pageToken) {
  var url = 'https://merchantapi.googleapis.com/reports/v1/accounts/' + merchantId + '/reports:search';
  var payload = { query: query, pageSize: 1000 };
  if (pageToken) payload.pageToken = pageToken;

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code !== 200) throw new Error(explainApiError_(code, text));
  return JSON.parse(text);
}

/** Chybové hlášky Merchant API jsou obecné. Tohle je překládá na příčinu. */
function explainApiError_(code, text) {
  var message = text;
  try { message = JSON.parse(text).error.message; } catch (e) { /* necháme syrový text */ }

  if (code === 403 && /Merchant API has not been used|disabled/i.test(message)) {
    return 'HTTP 403: Merchant API není povolené v Cloud projektu, na který je skript napojený. ' +
      'Nastavení projektu → Projekt Google Cloud → vlastní projekt, tam Merchant API zapněte.';
  }
  if (code === 403) {
    return 'HTTP 403: Google účet, pod kterým skript běží, nemá přístup do tohohle Merchant Centra. ' + message;
  }
  if (code === 409 && /v1beta/i.test(message)) {
    return 'HTTP 409: skript volá zrušenou verzi API. Merchant API v1beta skončila 28. 2. 2026, používejte v1.';
  }
  if (code === 404) {
    return 'HTTP 404: účet ' + 'nenalezen. Zkontrolujte MERCHANT_ID, patří tam jen číslice.';
  }
  if (code === 429) {
    return 'HTTP 429: překročený limit dotazů. Spouštějte skript nejvýš jednou za hodinu.';
  }
  return 'HTTP ' + code + ': ' + message;
}

// ============================================================================
//  VÝSTUPY
// ============================================================================

function sendAlert_(merchantId, snapshot, previous, verdict) {
  if (CONFIG.CHAT_WEBHOOK_URL) {
    postToChat_(CONFIG.CHAT_WEBHOOK_URL, buildChatCard_(merchantId, snapshot, previous, verdict));
  }
  if (CONFIG.EMAIL) {
    MailApp.sendEmail({
      to: CONFIG.EMAIL,
      subject: buildEmailSubject_(merchantId, snapshot, verdict),
      htmlBody: buildEmailHtml_(merchantId, snapshot, previous, verdict),
    });
  }
}

function buildEmailSubject_(merchantId, snapshot, verdict) {
  if (!verdict.shouldAlert) return 'Merchant Center ' + merchantId + ': beze změny (' + snapshot.watched + ')';
  var delta = verdict.delta === null ? '' : (verdict.delta > 0 ? ' (+' + verdict.delta + ')' : ' (' + verdict.delta + ')');
  return 'Merchant Center ' + merchantId + ': ' + snapshot.watched + ' zamítnutých produktů' + delta;
}

function buildEmailHtml_(merchantId, snapshot, previous, verdict) {
  var rows = topIssues_(snapshot.issues, previous && previous.issues, CONFIG.MAX_ISSUES_IN_ALERT);
  var html = [];
  html.push('<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#0F1B2D">');
  html.push('<h2 style="margin:0 0 4px">Merchant Center ' + merchantId + '</h2>');
  html.push('<p style="margin:0 0 16px;color:#475569">' + snapshot.date + '</p>');

  if (verdict.reasons.length) {
    html.push('<p style="margin:0 0 16px;padding:12px 14px;background:#FEF3C7;border-radius:8px">' +
      '<strong>Proč vám to píšu:</strong><br>' + verdict.reasons.join('<br>') + '</p>');
  }

  html.push('<table style="border-collapse:collapse;margin-bottom:20px">');
  html.push(row_('Zamítnuté', snapshot.disapproved, previous && previous.disapproved));
  if (CONFIG.TRACK_LIMITED) html.push(row_('Omezené', snapshot.limited, previous && previous.limited));
  html.push(row_('Čekající na kontrolu', snapshot.pending, previous && previous.pending));
  html.push(row_('Katalog celkem', snapshot.total, previous && previous.total));
  html.push('</table>');

  html.push('<p style="margin:0 0 6px"><strong>Podíl na katalogu:</strong> ' + fmtPct_(verdict.share) + '</p>');

  if (rows.length) {
    html.push('<h3 style="margin:20px 0 8px">Důvody</h3>');
    html.push('<table style="border-collapse:collapse">');
    html.push('<tr><th align="left" style="padding:6px 14px 6px 0;border-bottom:1px solid #E2E8F0">Důvod</th>' +
      '<th align="right" style="padding:6px 0;border-bottom:1px solid #E2E8F0">Produktů</th>' +
      '<th align="right" style="padding:6px 0 6px 14px;border-bottom:1px solid #E2E8F0">Změna</th></tr>');
    rows.forEach(function (r) {
      html.push('<tr><td style="padding:6px 14px 6px 0">' + escapeHtml_(r.code) + (r.isNew ? ' <span style="color:#B45309">nový</span>' : '') + '</td>' +
        '<td align="right" style="padding:6px 0">' + r.count + '</td>' +
        '<td align="right" style="padding:6px 0 6px 14px;color:' + (r.delta > 0 ? '#B91C1C' : r.delta < 0 ? '#15803D' : '#475569') + '">' + fmtDelta_(r.delta) + '</td></tr>');
    });
    html.push('</table>');
  }

  html.push('<p style="margin:24px 0 0"><a href="https://merchants.google.com/mc/products/diagnostics?a=' + merchantId + '">Otevřít diagnostiku v Merchant Center</a></p>');
  html.push('<p style="margin:20px 0 0;color:#94A3B8;font-size:12px">Denní monitoring zamítnutých produktů · ' +
    '<a href="https://karelhuk.cz" style="color:#94A3B8">karelhuk.cz</a></p>');
  html.push('</div>');
  return html.join('');
}

function row_(label, value, prev) {
  var delta = (prev === null || prev === undefined) ? null : value - prev;
  return '<tr><td style="padding:4px 20px 4px 0;color:#475569">' + label + '</td>' +
    '<td align="right" style="padding:4px 0;font-weight:600">' + value + '</td>' +
    '<td style="padding:4px 0 4px 12px;color:#475569">' + (delta === null ? '' : fmtDelta_(delta)) + '</td></tr>';
}

/**
 * Google Chat bere buď prostý text, nebo karty. Karta drží tabulku důvodů
 * čitelnou i na mobilu, kam většina lidí tenhle alert dostane.
 */
function buildChatCard_(merchantId, snapshot, previous, verdict) {
  var rows = topIssues_(snapshot.issues, previous && previous.issues, CONFIG.MAX_ISSUES_IN_ALERT);
  var widgets = [];

  if (verdict.reasons.length) {
    widgets.push({ decoratedText: { topLabel: 'Proč vám to píšu', text: verdict.reasons.join('<br>'), wrapText: true } });
  }

  var summary = snapshot.disapproved + ' zamítnutých';
  if (CONFIG.TRACK_LIMITED) summary += ', ' + snapshot.limited + ' omezených';
  summary += ' z ' + snapshot.total + ' produktů (' + fmtPct_(verdict.share) + ')';
  if (previous) summary += '<br>Včera: ' + previous.watched + ' → dnes ' + snapshot.watched + ' (' + fmtDelta_(verdict.delta) + ')';
  widgets.push({ decoratedText: { topLabel: 'Stav', text: summary, wrapText: true } });

  if (rows.length) {
    var issueText = rows.map(function (r) {
      return '<b>' + r.count + '×</b> ' + r.code + ' ' + fmtDelta_(r.delta) + (r.isNew ? ' (nový)' : '');
    }).join('<br>');
    widgets.push({ decoratedText: { topLabel: 'Důvody', text: issueText, wrapText: true } });
  }

  widgets.push({
    buttonList: {
      buttons: [{
        text: 'Otevřít diagnostiku',
        onClick: { openLink: { url: 'https://merchants.google.com/mc/products/diagnostics?a=' + merchantId } },
      }],
    },
  });

  return {
    cardsV2: [{
      cardId: 'gmc-' + merchantId,
      card: {
        header: {
          title: 'Merchant Center ' + merchantId,
          subtitle: snapshot.date,
        },
        sections: [{ widgets: widgets }],
      },
    }],
  };
}

function postToChat_(webhookUrl, payload) {
  var response = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    Logger.log('Google Chat odmítl zprávu: HTTP ' + response.getResponseCode() + ' ' + response.getContentText());
  }
}

/** Chyba v běhu je taky informace. Bez tohohle tichý pád vypadá jako klid. */
function notifyError_(merchantId, err) {
  var text = 'Monitoring Merchant Center ' + merchantId + ' selhal: ' + err.message;
  if (CONFIG.CHAT_WEBHOOK_URL) postToChat_(CONFIG.CHAT_WEBHOOK_URL, { text: text });
  if (CONFIG.EMAIL) MailApp.sendEmail(CONFIG.EMAIL, 'Merchant Center monitoring selhal', text);
}

function appendToSheet_(merchantId, snapshot) {
  var sheet;
  try {
    var ss = SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
    sheet = ss.getSheetByName('gmc-monitor') || ss.insertSheet('gmc-monitor');
  } catch (e) {
    Logger.log('Sheet se nepodařilo otevřít, historie se nezapsala: ' + e.message);
    return;
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Datum', 'Účet', 'Celkem', 'Zamítnuté', 'Omezené', 'Čekající', 'Podíl %', 'Top důvody']);
    sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
  }
  var top = topIssues_(snapshot.issues, null, 5).map(function (r) { return r.code + ': ' + r.count; }).join(' | ');
  var share = snapshot.total ? (100 * snapshot.watched / snapshot.total) : 0;
  sheet.appendRow([snapshot.date, merchantId, snapshot.total, snapshot.disapproved,
    snapshot.limited, snapshot.pending, Math.round(share * 100) / 100, top]);
}

function formatPlainText_(merchantId, snapshot, previous, verdict) {
  var lines = [];
  lines.push('Merchant Center ' + merchantId + ' — ' + snapshot.date);
  lines.push('  katalog: ' + snapshot.total);
  lines.push('  zamítnuté: ' + snapshot.disapproved + (previous ? ' (včera ' + previous.disapproved + ')' : ''));
  if (CONFIG.TRACK_LIMITED) lines.push('  omezené: ' + snapshot.limited + (previous ? ' (včera ' + previous.limited + ')' : ''));
  lines.push('  podíl: ' + fmtPct_(verdict.share));
  lines.push('  alert: ' + (verdict.shouldAlert ? 'ANO — ' + verdict.reasons.join('; ') : 'ne'));
  topIssues_(snapshot.issues, previous && previous.issues, CONFIG.MAX_ISSUES_IN_ALERT).forEach(function (r) {
    lines.push('    ' + r.count + '× ' + r.code + ' ' + fmtDelta_(r.delta) + (r.isNew ? ' (nový)' : ''));
  });
  return lines.join('\n');
}

// ============================================================================
//  HISTORIE A POMOCNÉ FUNKCE
// ============================================================================

function loadPrevious_(merchantId) {
  var raw = PropertiesService.getScriptProperties().getProperty('snapshot_' + merchantId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function savePrevious_(merchantId, snapshot) {
  PropertiesService.getScriptProperties()
    .setProperty('snapshot_' + merchantId, JSON.stringify(snapshot));
}

/** Důvody seřazené podle počtu zasažených produktů, s meziden­ní změnou. */
function topIssues_(issues, previousIssues, limit) {
  var rows = Object.keys(issues || {}).map(function (code) {
    var prev = (previousIssues && previousIssues[code]) || 0;
    return { code: code, count: issues[code], delta: issues[code] - prev, isNew: !prev };
  });
  rows.sort(function (a, b) { return b.count - a.count; });
  if (limit && rows.length > limit) {
    var rest = rows.slice(limit);
    var restCount = rest.reduce(function (s, r) { return s + r.count; }, 0);
    rows = rows.slice(0, limit);
    rows.push({ code: 'a další (' + rest.length + ')', count: restCount, delta: 0, isNew: false });
  }
  return rows;
}

function fmtPct_(value) {
  if (!isFinite(value)) return 'z nuly';
  return (Math.round(value * 10) / 10).toString().replace('.', ',') + ' %';
}

function fmtDelta_(delta) {
  if (delta === null || delta === undefined || delta === 0) return '±0';
  return delta > 0 ? '+' + delta : String(delta);
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
