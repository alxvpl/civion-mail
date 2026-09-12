# CIVION Mail v0.6.11 — Privacy Statement

## Режим

Версия 0.5.0 работи изцяло локално. Няма облачен AI provider, telemetry endpoint, update endpoint, remote script, remote font или друга мрежова интеграция в кода на разширението.

## Какво се прочита

За новопостъпилите писма и за писмата, включени в изрично стартиран Historical Scan, CIVION Mail временно прочита:

- Thunderbird message identifier и `Message-ID` header;
- папка и акаунт;
- подател, получатели, тема и дата;
- MIME заглавки и четимите inline текстови части;
- `Authentication-Results`, `Reply-To`, `Return-Path` и `Sender` headers — временно, за локална DMARC/DKIM/SPF и domain-alignment оценка;
- целите (`href`) и видимия текст на хипервръзките в HTML тялото — само временно, за локален анализ на риска (несъответствие текст/цел, lookalike домейни, punycode, IP адреси); връзките не се записват в анализните записи и не се отварят или заявяват;
- имената, MIME типовете и размерите на приложенията.

## Какво се съхранява

В `messenger.storage.local` се съхраняват:

- подател, тема и дата;
- кратко резюме и извлечено действие;
- категории, приоритет и статус;
- срокове и суми;
- language result, confidence и risk indicators;
- минимизиран mail-authentication резултат (verdict, DMARC/DKIM/SPF status, използван домейн/alignment и trusted authserv-id); суровият `Authentication-Results` header не се записва в анализа;
- metadata за важните приложения;
- Relationship Class, Document Type, Obligation state, Retention recommendation и CIVIC MAP candidate status;
- SHA-256 hash на нормализирания анализиран текст за нови/re-analyzed записи; hash-ът не съдържа самото тяло;
- технически идентификатори за отваряне на оригиналното писмо;
- локални потребителски бележки и field-level manual provenance;
- настройки, включително локалните user whitelist/blocklist домейни, и ограничен диагностичен лог;
- при необходимост — bounded recovery journal за legacy стойности, които не могат безопасно да станат активни записи.

Пълният текст на писмото и самите приложения не се съхраняват в `messenger.storage.local`. При включен Desktop bridge v0.6.3 може да предаде exact RFC822 bytes локално към CIVION Desktop за evidence preservation. Desktop ги пази като недоверено локално доказателство; приложенията остават MIME части и не се отварят автоматично.

От v0.6.8 разпознат PDF документ може да бъде прочетен като точни bytes чрез Thunderbird и предаден единствено на локалния Desktop host. Host-ът проверява размер, PDF signature и SHA-256, а след това го записва под `F:\01_ARCHIVE\CIVION` в одобрена структурирана папка. В extension storage се пазят само статус, hash и архивен път, не копие на PDF файла.


## Historical Scan

Historical Scan никога не започва автоматично. Потребителят изрично избира папки, период и обхват и стартира операцията. По подразбиране Junk/Sent/Drafts/Templates/Trash не са избрани. Съществуващите записи се пропускат, освен ако потребителят изрично поиска re-analysis. Thunderbird тагове не се променят при historical import, освен ако отделно е включена тази опция. Scan-ът може да бъде спрян ръчно; вече записаните анализи остават локално.

## Архивиране на съществуващи PDF документи

От v0.6.10 правилото „само четене над Junk" важи по всички пътища: съобщение в Junk папка никога не се тагва, премества или променя, включително при изричен ръчен анализ и в AUTO TAG режим. Съобщение, което не е допуснато от портата, не получава присъда и не създава запис.

От v0.6.9 отделната команда `Archive existing PDFs` обхожда всички нормални папки във всички акаунти. Trash, Junk, Sent, Drafts, Templates, Outbox, виртуалните и обединените папки са изключени. Няма ограничение по дата или брой писма. Преди анализ се прочита само списъкът с приложения; съдържанието на писмото се анализира локално само ако има PDF. Командата започва единствено след потвърждение, показва прогрес и може да бъде спряна и продължена.

## Локален JSON export

Action Center може да създаде JSON export чрез локален `Blob`. Файлът се генерира на устройството и не се изпраща към външна услуга. След създаването му потребителят контролира къде се съхранява и дали ще бъде споделен.

## CIVION candidate export

Action Center може изрично да създаде локален candidate-only пакет `CIVION_MAIL_CANDIDATE_PACKAGE` v2 по `CivionMailIngestion` v0.2. Пакетът не се изпраща автоматично и не дава на CIVION Mail право да записва директно в CIVION Core/PostgreSQL. CIVION Civic полетата са reference candidates; каноничната административна идентичност остава отговорност на CIVION Civic/Core според активните module contracts.

## Автоматичен локален Desktop bridge

От v0.6.2 CIVION Mail използва Desktop-owned Native Messaging host `nl.civion.desktop` като основен unattended same-machine transport. Candidate пакетите запазват candidate-only authority. В v0.6.3 отделен `untrusted_evidence_only` пакет може да съдържа bounded exact RFC822 bytes, когато Thunderbird все още има съобщението. Transport-ът не е канонично приемане и не разрешава външни действия. Функцията може да бъде изключена от Settings. Старият Downloads spool остава read-compatible diagnostic канал само за candidate JSON пакети.

PDF архивът от v0.6.8 никога не използва Downloads. Ако `F:\01_ARCHIVE\CIVION` не е достъпен, документът не се записва другаде: отбелязва се `pending` и може да бъде изпратен повторно. Няма облачно изпращане.

## Recovery export

При migration проблеми Diagnostics може да създаде отделен локален recovery JSON. Той може да съдържа стари теми, податели или analysis values и затова интерфейсът показва изрично предупреждение преди създаването. Recovery export не се изпраща автоматично никъде.

## Изпращане на данни

Разширението не изпраща данни към външна услуга. Няма `fetch`, `XMLHttpRequest` или remote host permission. `nativeMessaging` комуникира единствено с локалния Desktop-owned host `nl.civion.desktop` на същата машина.

## Диагностика

Подробният диагностичен лог е изключен по подразбиране. Когато е включен, записва ограничени технически грешки, но не и пълния текст на писмото. Локалните error записи могат да съдържат тема до 200 знака или `Message-ID`, когато това е необходимо за намиране на проблем.

Диагностичният JSON export е отделен, минимизиран отчет. Той премахва имената и вътрешните ID на акаунтите, email адресите, темите, подателите, `Message-ID`, съдържанието на писмата и свободния текст на diagnostic errors. Запазват се версии, API checks, типове акаунти, брой папки, броячи, error codes, нива и timestamps.

## Изтриване

Потребителят може:

- да премахне отделен анализ;
- да изтрие ръчно оригиналния имейл от detail view или от контекстното меню на реда. Това действие използва Thunderbird `messages.delete()` само след изрично потвърждение, с `deletePermanently: false`; CIVION Mail не извършва автоматично или permanent delete;
- да добавя или премахва sender domains от локален whitelist/blocklist. Whitelist не е authentication bypass и не отменя Protected Identity hard block;
- да изчисти всички Completed и Dismissed записи;
- да намали retention периода и максималния брой записи;
- да деинсталира разширението и да изтрие неговото локално storage пространство чрез Thunderbird.

Новото разрешение `messagesDelete` се използва единствено за горното ръчно действие. То не добавя мрежов достъп и не променя `connect-src 'none'`.

## Бъдещи облачни режими

Облачен или хибриден режим не е включен във v0.6.9. Ако бъде добавен, той трябва да бъде отделно, изрично включвана функция с ясно посочени provider, изпращани полета, retention политика и потребителско съгласие.
