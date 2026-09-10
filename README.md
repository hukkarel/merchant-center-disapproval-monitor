# Denní monitoring zamítnutých produktů v Google Merchant Center

Skript pro Google Apps Script. Jednou denně načte stav katalogu přes Merchant API, porovná ho s předchozím dnem a při zhoršení pošle zprávu do Google Chatu nebo e-mailem.

## Co to je

Sto řádků konfigurace okolo jednoho dotazu na Merchant API. Běží zdarma v Google Apps Scriptu, takže nepotřebujete server ani cron. Ukládá si denní snímek, aby měl příště s čím porovnávat.

Alert obsahuje tři čísla, která potřebujete k rozhodnutí:

- **absolutní rozdíl**: bylo 12, je 260
- **podíl na katalogu**: 0,3 % → 27 %
- **důvody zamítnutí**, seřazené podle počtu zasažených produktů, s tím, které jsou nové

## Jaký problém řeší

Merchant Center vám ukáže aktuální stav. Neřekne vám, že se změnil.

Když v pátek večer dodavatel přepíše dostupnost u čtvrtiny katalogu, uvidíte v pondělí ráno číslo, které vypadá stejně nevinně jako kterékoli jiné. Rozdíl proti pátku nikde není. A přesně ten rozdíl je informace, kvůli které byste zasáhli.

Druhý problém je pojmenování příčiny. Zamítnutí kvůli chybějícímu GTIN a zamítnutí kvůli policy porušení vyžadují jiného člověka a jinou reakci. Souhrnné číslo „260 zamítnutých" vám neřekne, kterou z těch dvou situací řešíte.

Skript proto hlásí čtyři situace a v každé zprávě říká, která z nich nastala:

| Podmínka | Výchozí práh | K čemu je |
|---|---|---|
| Absolutní nárůst | 10 produktů | malý katalog, kde procenta skáčou |
| Relativní nárůst | 20 % | velký katalog, kde deset produktů nic neznamená |
| Nový důvod zamítnutí | zapnuto | policy zásah nebo rozbitý atribut se pozná hned |
| Podíl na katalogu | 5 % | pojistka, když ostatní prahy prošly plíživě |

Prahy jsou volba, ne doporučení Googlu. Google žádné nedává.

## Pro koho je to

Pro toho, kdo odpovídá za výkon Shopping kampaní a má v Merchant Centru víc produktů, než kolik jich denně projde očima. Prakticky od několika set položek výš.

Nepotřebujete umět programovat. Potřebujete Google účet s přístupem do Merchant Centra a deset minut na nastavení.

## Jak se používá

### 1. Cloud projekt s povoleným Merchant API

Apps Script má vlastní skrytý Cloud projekt, ve kterém Merchant API zapnout nejde. Potřebujete tedy svůj.

1. [console.cloud.google.com](https://console.cloud.google.com) → vytvořte projekt (nebo použijte existující)
2. APIs & Services → Library → najděte **Merchant API** → Enable
3. V nastavení projektu si opište **číslo projektu** (Project number, ne ID)

### 2. Skript

1. [script.google.com](https://script.google.com) → Nový projekt
2. Obsah `monitor.gs` vložte do editoru
3. Nastavení projektu → zaškrtněte **Zobrazit soubor manifestu appsscript.json**
4. Obsah `appsscript.json` z tohohle repozitáře vložte do souboru, který se objeví
5. Nastavení projektu → Projekt Google Cloud → **Změnit projekt** → vložte číslo projektu z kroku 1

### 3. Konfigurace

V `monitor.gs` nahoře vyplňte:

```javascript
MERCHANT_ID: '123456789',                                  // ID účtu Merchant Center
CHAT_WEBHOOK_URL: 'https://chat.googleapis.com/v1/...',    // nebo
EMAIL: 'vy@firma.cz',
```

Webhook do Google Chatu získáte v místnosti: název místnosti → Aplikace a integrace → Webhooky → Přidat webhook.

Pro víc účtů najednou: `MERCHANT_ID: ['123456789', '987654321']`.

### 4. První spuštění

Spusťte funkci `runOnce()`. Google se zeptá na oprávnění, potvrďte je. Ve **Zobrazit → Protokol spuštění** uvidíte, co skript našel.

První běh nemá s čím porovnávat, takže alert pošle jen tehdy, když je podíl zamítnutých nad prahem. Od druhého dne hlídá rozdíly.

### 5. Denní spouštění

Spusťte `installDailyTrigger()`. Skript pak poběží každý den kolem sedmé ráno.

Zrušíte ho funkcí `removeTriggers()`, uloženou historii smaže `resetHistory()`.

## Jaký je příklad

Katalog s 946 produkty, běžný den:

```
Merchant Center 9414957 — 2026-09-05 07:00
  katalog: 946
  zamítnuté: 3 (včera 3)
  omezené: 1 (včera 1)
  podíl: 0,4 %
  alert: ne
```

Tentýž katalog po tom, co dodavatel přepsal dostupnost:

```
Merchant Center 9414957 — 2026-09-06 07:00
  katalog: 946
  zamítnuté: 187 (včera 3)
  omezené: 1 (včera 1)
  podíl: 19,9 %
  alert: ANO — přibylo 184 produktů, práh je 10; nárůst o 4600 %,
         práh je 20 %; zasaženo 19,9 % katalogu, práh je 5 %;
         nový důvod zamítnutí: availability_mismatch (disapproved)
    184× availability_mismatch (disapproved) +184 (nový)
      2× image_link_internal_error (disapproved) ±0
      1× recalled_product (disapproved) ±0
```

Do Google Chatu dorazí totéž jako karta s tlačítkem na diagnostiku, e-mailem jako tabulka.

Volitelně skript zapisuje jeden řádek denně do Google Sheetu (`SPREADSHEET_URL`), takže po měsíci máte křivku a víte, jestli je dnešek výkyv, nebo trend.

## Poznámky k API

Skript používá **Merchant API v1**. Verze `v1beta` byla zrušena 28. února 2026 a vrací HTTP 409, takže starší návody na internetu dnes nefungují.

Dotaz jde na `reports.search` nad tabulkou `product_view` a stahuje jen tři pole: `id`, `aggregated_reporting_context_status` a `item_issues`. Jeden průchod katalogem tak stačí na počty i na důvody.

Autorizace běží přes `ScriptApp.getOAuthToken()`, takže se nikam neukládá klíč ani heslo. Skript vidí právě ty účty, které vidí Google účet, pod kterým ho spouštíte.

**Limit délky běhu**: Apps Script dá jednomu spuštění 6 minut, u Google Workspace 30 minut. Nad zhruba 200 000 produktů se celý katalog nemusí stihnout projít. Pak katalog rozdělte a sledujte jednotlivé `feed_label` zvlášť, tedy přidejte do dotazu `WHERE product_view.feed_label = 'CZ'` a založte na každý jeden projekt.

## Časté chyby

| Co uvidíte | Co s tím |
|---|---|
| `HTTP 403: Merchant API není povolené` | Krok 1 návodu. Skript je napojený na výchozí projekt, ne na váš. |
| `HTTP 403: nemá přístup do Merchant Centra` | Účet, pod kterým skript běží, není v Merchant Centru. Přidejte ho, stačí role pro čtení. |
| `HTTP 409` | Skript volá `v1beta`. Stáhněte si aktuální verzi odsud. |
| `HTTP 404` | V `MERCHANT_ID` je něco jiného než číslice. |
| Alert nechodí, log je v pořádku | Prahy jsou nad reálnou změnou. Snižte je, nebo si na zkoušku zapněte `ALWAYS_NOTIFY: true`. |

## English summary

Apps Script that watches Google Merchant Center for product disapprovals and alerts you when they get worse, not merely when they exist. Once a day it queries the Merchant API, compares the result with the previous run and posts to a Google Chat webhook or sends an email.

The alert carries the three things you need to act: the absolute change (12 → 260), the share of the catalogue affected (0.3 % → 27 %), and the disapproval reasons ranked by how many products they hit, flagging the ones that are new.

Four trigger conditions, any of which fires the alert: absolute increase, relative increase, a previously unseen issue code, or the affected share crossing a ceiling. Thresholds are your choice; Google publishes none.

Uses **Merchant API v1** — `v1beta` was discontinued on 28 February 2026 and now returns HTTP 409, so most tutorials online are out of date. Setup requires your own Cloud project with the Merchant API enabled, because Apps Script's default project cannot enable it. Full setup steps are in the Czech section above; the code comments are Czech, the configuration keys are English.

## Licence

MIT, viz [LICENSE](LICENSE). Software je poskytován „tak jak je", bez záruky.

---

**Author: Karel Huk**
E-commerce PPC & Google Ads automation
[https://karelhuk.cz](https://karelhuk.cz/?utm_source=github&utm_medium=referral&utm_campaign=github-scripts&utm_content=merchant-center-disapproval-monitor)
